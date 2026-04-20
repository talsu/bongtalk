import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { MetricsService } from './metrics/metrics.service';

/**
 * Task-016-C-4: DAU / WAU / MAU via `RefreshToken.createdAt`.
 *
 * Data source choice: the refresh-token rotation flow writes a new
 * `RefreshToken` row on every /auth/refresh call (every 15 min per
 * active user), so `MAX(createdAt)` per user is a strong proxy for
 * "last active within N days". Lighter than an audit_log pass, which
 * is the future-when-traffic-demands path.
 *
 * `lastUsedAt` was not added as a column — rotation's new-row
 * timestamp is functionally equivalent and avoids an extra UPDATE
 * per refresh.
 *
 * Cron: every 1 hour via a setInterval guard. Also runs once at
 * module init so `/metrics` has a warm value immediately; skips the
 * first-minute window to let the DB pool settle on boot.
 */
@Injectable()
export class ActiveUsersCollector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActiveUsersCollector.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    // Delay the first run 60s so containers booting under load don't
    // slam the DB with an unbounded distinct-count query on cold
    // caches.
    setTimeout(() => {
      void this.collectOnce();
    }, 60_000);
    this.timer = setInterval(
      () => {
        void this.collectOnce();
      },
      60 * 60 * 1000,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Public so a unit test can inject a mocked Prisma + assert gauge values. */
  async collectOnce(): Promise<{ '1d': number; '7d': number; '30d': number }> {
    try {
      const rows = await this.prisma.$queryRaw<{ window: string; count: bigint }[]>`
        SELECT '1d'  AS window, COUNT(DISTINCT "userId")::bigint AS count
          FROM "RefreshToken"
         WHERE "createdAt" > NOW() - interval '1 day'
        UNION ALL
        SELECT '7d'  AS window, COUNT(DISTINCT "userId")::bigint AS count
          FROM "RefreshToken"
         WHERE "createdAt" > NOW() - interval '7 days'
        UNION ALL
        SELECT '30d' AS window, COUNT(DISTINCT "userId")::bigint AS count
          FROM "RefreshToken"
         WHERE "createdAt" > NOW() - interval '30 days'
      `;
      const out: { '1d': number; '7d': number; '30d': number } = { '1d': 0, '7d': 0, '30d': 0 };
      for (const r of rows) {
        const n = Number(r.count);
        if (r.window === '1d') out['1d'] = n;
        else if (r.window === '7d') out['7d'] = n;
        else if (r.window === '30d') out['30d'] = n;
        this.metrics.activeUsers.labels(r.window).set(n);
      }
      return out;
    } catch (err) {
      // Informational metric — a failed tick is non-fatal; log + the
      // gauge just keeps its previous value until the next tick.
      this.logger.warn(
        `[active-users] collect failed err=${(err as Error).message?.slice(0, 200) ?? 'unknown'}`,
      );
      return { '1d': 0, '7d': 0, '30d': 0 };
    }
  }
}
