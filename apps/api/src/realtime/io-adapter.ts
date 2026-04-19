import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplicationContext, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { REDIS } from '../redis/redis.module';

/**
 * Socket.IO IoAdapter with the Redis pub/sub adapter attached so multiple
 * NestApplication instances can fan events out across every connected
 * socket. The underlying `ioredis` is the same connection pool the rest of
 * the app uses (rate limit + presence + replay buffer) — the adapter takes
 * its own duplicated pair because the pub/sub protocol puts the subscriber
 * connection into a mode where it cannot serve normal commands.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const base = this.app.get<Redis>(REDIS);
    const pubClient = base.duplicate();
    const subClient = base.duplicate();
    // `ping()` returns only after the connection is ready — simpler and
    // race-proof vs listening for the `ready` event which can fire before
    // our listener is registered.
    await Promise.all([pubClient.ping(), subClient.ping()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('[realtime] redis adapter connected (pub/sub mode)');
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
