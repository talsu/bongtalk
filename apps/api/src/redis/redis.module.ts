import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';

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
      useFactory: (): Redis => {
        const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
        return new Redis(url, {
          maxRetriesPerRequest: 3,
          lazyConnect: false,
          keyPrefix: 'qufox:',
        });
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
