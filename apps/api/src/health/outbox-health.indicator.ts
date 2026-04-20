import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { MetricsService } from '../observability/metrics/metrics.service';

const STALE_AFTER_SEC = 10;
const BACKLOG_CACHE_TTL_MS = 1_000;

export type OutboxHealthState = 'healthy' | 'idle' | 'stalled';

export interface OutboxHealthResult {
  ok: boolean;
  state: OutboxHealthState;
  reason?: string;
}

/**
 * Task-020-A: idle-vs-stalled discriminator.
 *
 *   - IDLE:     dispatcher running, outbox empty, quiet window. 200.
 *   - STALLED:  undispatched rows older than STALE_AFTER_SEC piling
 *               up AND dispatcher hasn't ticked. Page someone. 503.
 *   - HEALTHY:  backlog draining or never accrued. 200.
 *
 * Reviewer round-1 fixes folded in:
 *   1. Reads `outbox_last_dispatch_timestamp_seconds` via prom-client's
 *      public async `.get()` — no private `.hashMap` access.
 *   2. DB count failures no longer silently pose as healthy; they
 *      surface as `state: 'stalled', reason: 'db-error'` so the
 *      operator sees it even if the sibling $queryRaw SELECT 1 passed
 *      (statement timeout / lock wait).
 *   3. 1-second in-memory cache on the backlog count so /readyz
 *      polling (every 2s during auto-deploy health-wait) doesn't
 *      drive redundant COUNTs. The partial-index migration added in
 *      the same commit keeps the query planner on an index scan of
 *      undispatched rows only — cache is belt-and-suspenders.
 */
@Injectable()
export class OutboxHealthIndicator {
  private readonly logger = new Logger(OutboxHealthIndicator.name);
  private cached: { at: number; backlogStale: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async check(): Promise<OutboxHealthResult> {
    const thresholdMs = STALE_AFTER_SEC * 1000;
    const cutoff = new Date(Date.now() - thresholdMs);

    let backlogStale: number;
    const hit = this.cached;
    if (hit && Date.now() - hit.at < BACKLOG_CACHE_TTL_MS) {
      backlogStale = hit.backlogStale;
    } else {
      try {
        backlogStale = await this.prisma.outboxEvent.count({
          where: { dispatchedAt: null, occurredAt: { lt: cutoff } },
        });
        this.cached = { at: Date.now(), backlogStale };
      } catch (err) {
        this.logger.warn(
          `[outbox-health] backlog count failed: ${(err as Error).message.slice(0, 200)}`,
        );
        return {
          ok: false,
          state: 'stalled',
          reason: 'db-error (backlog count failed)',
        };
      }
    }

    const ageSec = await this.lastTickAgeSec();
    const tickRecent = ageSec === null || ageSec <= STALE_AFTER_SEC;

    if (backlogStale > 0 && !tickRecent) {
      return {
        ok: false,
        state: 'stalled',
        reason: `stalled (${backlogStale} undispatched row${
          backlogStale === 1 ? '' : 's'
        } older than ${STALE_AFTER_SEC}s; last tick ${ageSec?.toFixed(1) ?? '—'}s ago)`,
      };
    }

    if (backlogStale > 0 && tickRecent) {
      // Dispatcher moving; backlog draining. Healthy under load.
      return { ok: true, state: 'healthy' };
    }

    // backlogStale === 0
    return { ok: true, state: ageSec === null || !tickRecent ? 'idle' : 'healthy' };
  }

  /** Clear the 1s backlog cache — exposed for integration tests. */
  invalidateCache(): void {
    this.cached = null;
  }

  private async lastTickAgeSec(): Promise<number | null> {
    if (!this.metrics) return null;
    const rendered = await this.metrics.outboxLastDispatchTimestampSeconds.get();
    const sample = rendered.values[0];
    if (!sample || typeof sample.value !== 'number' || sample.value <= 0) return null;
    return Date.now() / 1000 - sample.value;
  }
}
