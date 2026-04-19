import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Response } from 'express';
import { HealthResponse } from '@qufox/shared-types';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { OutboxHealthIndicator } from './outbox-health.indicator';

const VERSION = process.env.APP_VERSION ?? '0.1.0';
const startedAt = Date.now();
const CHECK_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(onTimeout), ms))]);
}

@Controller()
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly outboxHealth: OutboxHealthIndicator,
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

  /**
   * Deep readiness. Each external check has a 5s timeout — the canary
   * pipeline polls /readyz every 30s and a slow DB shouldn't block the
   * whole response. Returns 503 when any check fails so upstream (nginx,
   * k8s) can cut traffic automatically.
   */
  @Public()
  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{
    status: 'ok' | 'degraded';
    checks: { db: 'ok' | 'fail'; redis: 'ok' | 'fail'; outbox: 'ok' | 'stalled' };
    details?: { outbox?: string };
  }> {
    const [dbOk, redisOk] = await Promise.all([
      withTimeout(
        this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        CHECK_TIMEOUT_MS,
        false,
      ),
      withTimeout(
        this.redis
          .ping()
          .then((r) => r === 'PONG')
          .catch(() => false),
        CHECK_TIMEOUT_MS,
        false,
      ),
    ]);
    const outbox = await this.outboxHealth.check();
    const ok = dbOk && redisOk && outbox.ok;
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      checks: {
        db: dbOk ? 'ok' : 'fail',
        redis: redisOk ? 'ok' : 'fail',
        outbox: outbox.ok ? 'ok' : 'stalled',
      },
      ...(outbox.reason ? { details: { outbox: outbox.reason } } : {}),
    };
  }
}
