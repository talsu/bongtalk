import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

export type RateLimitRule = {
  key: string;
  windowSec: number;
  max: number;
};

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(rule: RateLimitRule): Promise<{ count: number; ttl: number }> {
    const redisKey = `rl:${rule.key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, rule.windowSec);
    }
    const ttl = await this.redis.ttl(redisKey);
    return { count, ttl };
  }

  async enforce(rules: RateLimitRule[]): Promise<void> {
    for (const rule of rules) {
      const { count, ttl } = await this.hit(rule);
      if (count > rule.max) {
        throw new DomainError(ErrorCode.RATE_LIMITED, `rate limited: ${rule.key}`, {
          retryAfterSec: Math.max(ttl, 1),
        });
      }
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}
