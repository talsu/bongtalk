import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { HealthResponse, ReadyResponse } from '@qufox/shared-types';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';

const VERSION = process.env.APP_VERSION ?? '0.1.0';
const startedAt = Date.now();

@Controller()
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('healthz')
  health(): HealthResponse {
    return {
      status: 'ok',
      version: VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    };
  }

  @Public()
  @Get('readyz')
  async ready(): Promise<ReadyResponse> {
    const dbOk = await this.prisma
      .$queryRaw`SELECT 1`.then(() => true)
      .catch(() => false);
    const redisOk = await this.redis
      .ping()
      .then((r) => r === 'PONG')
      .catch(() => false);
    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      checks: { db: dbOk, redis: redisOk },
    };
  }
}
