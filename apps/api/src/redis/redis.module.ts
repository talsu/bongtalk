import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { MetricsService } from '../observability/metrics/metrics.service';

export const REDIS = Symbol('REDIS_CLIENT');

@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly client: Redis) {}
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      // MetricsService is Optional so tests without the observability module
      // still work. When wired, we use ioredis's 'commandQueued.execute' hook
      // (Redis#call wrapper) via custom monitor instead of a full MONITOR
      // command — that would double every round-trip.
      inject: [{ token: MetricsService, optional: true }],
      useFactory: (metrics?: MetricsService): Redis => {
        const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
        const client = new Redis(url, {
          maxRetriesPerRequest: 3,
          lazyConnect: false,
          keyPrefix: 'qufox:',
        });
        if (metrics) {
          instrumentRedis(client, metrics);
        }
        return client;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}

// Known ioredis commands we care about — bounded so a caller can't blow up
// cardinality by issuing a command string the client doesn't recognise
// (unusual, but defensive).
const REDIS_COMMAND_ALLOWLIST = new Set([
  'ping',
  'get',
  'set',
  'del',
  'incr',
  'expire',
  'ttl',
  'exists',
  'hset',
  'hget',
  'hdel',
  'hgetall',
  'sadd',
  'srem',
  'scard',
  'smembers',
  'sismember',
  'sunion',
  'keys',
  'scan',
  'xadd',
  'xrange',
  'xlen',
  'xread',
  'multi',
  'exec',
  'publish',
  'subscribe',
  'pipeline',
  'quit',
]);

function instrumentRedis(client: Redis, metrics: MetricsService): void {
  // ioredis does NOT expose commandQueued/commandExecuted events (my first
  // pass assumed they did — they don't). The reliable hook is
  // `Commander#sendCommand`, which every typed helper funnels through.
  // We wrap it once; each call times one round-trip.
  type Cmd = { name?: string; promise?: Promise<unknown> };
  const original = (
    client as unknown as {
      sendCommand: (c: Cmd, stream?: unknown) => Promise<unknown>;
    }
  ).sendCommand.bind(client);
  (client as unknown as { sendCommand: typeof original }).sendCommand = (
    cmd: Cmd,
    stream?: unknown,
  ) => {
    const rawName = (cmd?.name ?? '').toLowerCase();
    const label = REDIS_COMMAND_ALLOWLIST.has(rawName) ? rawName : '_other';
    const start = process.hrtime.bigint();
    const result = original(cmd, stream);
    // `cmd.promise` resolves when the server responds; fall back to
    // `result` for older ioredis versions.
    const settle = cmd?.promise ?? result;
    void Promise.resolve(settle).finally(() => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.redisCommandDurationSeconds.labels(label).observe(durationSec);
    });
    return result;
  };
}
