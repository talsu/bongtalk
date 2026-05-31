import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter, createShardedAdapter } from '@socket.io/redis-adapter';
import { INestApplicationContext, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { REDIS } from '../redis/redis.module';

type AdapterFactory = ReturnType<typeof createAdapter> | ReturnType<typeof createShardedAdapter>;

/**
 * Socket.IO IoAdapter with the Redis adapter attached so multiple
 * NestApplication instances can fan events out across every connected
 * socket. The underlying `ioredis` is the same connection pool the rest of
 * the app uses (rate limit + presence + replay buffer) — the adapter takes
 * its own duplicated pair because the pub/sub protocol puts the subscriber
 * connection into a mode where it cannot serve normal commands.
 *
 * FR-RT-16 — Redis 7 sharded Pub/Sub. We use `createShardedAdapter`, which
 * fans out via SSUBSCRIBE/SPUBLISH (sharded channels) instead of the global
 * PUBLISH used by the standard adapter. ioredis exposes `ssubscribe`/
 * `spublish` and the `smessageBuffer` event the adapter relies on, so no
 * client swap is needed. The multi-node fan-out integration test
 * (ws.multi-node.int.spec.ts) gates this: if sharded mode ever regressed
 * cross-instance delivery, flip USE_SHARDED back to false to fall back to
 * the standard pub/sub adapter (which already satisfies the FR's core
 * multi-instance fan-out requirement).
 */
const USE_SHARDED = true;

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: AdapterFactory | null = null;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const base = this.app.get<Redis>(REDIS);
    // review BLOCKER-1: the shared app client sets `keyPrefix: 'qufox:'`. The
    // Socket.IO redis adapter manages its own `socket.io#…` channel namespace;
    // under sharded mode SSUBSCRIBE/SPUBLISH treat the channel as a KEY, so
    // ioredis would prepend `qufox:` on the wire while the adapter's handler
    // map is keyed by the un-prefixed channel → inbound lookups miss and
    // cross-node delivery silently drops. Clear the prefix on the duplicated
    // pub/sub pair so both standard and sharded adapters route correctly.
    const pubClient = base.duplicate({ keyPrefix: '' });
    const subClient = base.duplicate({ keyPrefix: '' });
    // `ping()` returns only after the connection is ready — simpler and
    // race-proof vs listening for the `ready` event which can fire before
    // our listener is registered.
    await Promise.all([pubClient.ping(), subClient.ping()]);
    if (USE_SHARDED) {
      this.adapterConstructor = createShardedAdapter(pubClient, subClient);
      this.logger.log('[realtime] redis adapter connected (sharded pub/sub mode, Redis 7)');
    } else {
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log('[realtime] redis adapter connected (standard pub/sub mode)');
    }
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter: (arg: unknown) => void;
    };
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
