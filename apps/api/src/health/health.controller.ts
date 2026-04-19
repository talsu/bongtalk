import { Controller, Get } from '@nestjs/common';
import { HealthResponse, ReadyResponse } from '@qufox/shared-types';

const VERSION = process.env.APP_VERSION ?? '0.1.0';
const startedAt = Date.now();

@Controller()
export class HealthController {
  @Get('healthz')
  health(): HealthResponse {
    return {
      status: 'ok',
      version: VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    };
  }

  @Get('readyz')
  async ready(): Promise<ReadyResponse> {
    // TODO(task-001): wire real DB + Redis checks when services module lands.
    const dbOk = true;
    const redisOk = true;
    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      checks: { db: dbOk, redis: redisOk },
    };
  }
}
