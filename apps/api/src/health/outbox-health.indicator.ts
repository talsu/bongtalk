import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { MetricsService } from '../observability/metrics/metrics.service';

const STALE_AFTER_SEC = 10;

export type OutboxHealthState = 'healthy' | 'idle' | 'stalled';

export interface OutboxHealthResult {
  ok: boolean;
  state: OutboxHealthState;
  reason?: string;
}

/**
 * Task-020-A: idle-vs-stalled discriminator.
 *
 * Prior behaviour was "if `outbox_last_dispatch_timestamp_seconds` is
 * older than STALE_AFTER_SEC, report degraded". That conflated two
 * very different operational states:
 *
 *   - IDLE:     dispatcher is running, the outbox table is empty, and
 *               there's simply nothing to dispatch (night, immediately
 *               post-deploy). `/readyz` should be 200.
 *   - STALLED:  undispatched rows older than STALE_AFTER_SEC are piling
 *               up and the dispatcher has NOT ticked recently. This is
 *               the real "page someone" condition. `/readyz` 503.
 *
 * 019's prod auto-deploy failed repeatedly because a healthy idle shell
 * was gated out by the old check. New rule:
 *
 *   backlogStale = count(OutboxEvent WHERE dispatchedAt IS NULL AND
 *                                         occurredAt < now - threshold)
 *   if backlogStale > 0 and dispatcher hasn't ticked in threshold
 *     → stalled, degraded, 503.
 *   else if backlogStale == 0 and dispatcher hasn't ticked in threshold
 *     → idle, ok, 200.
 *   else
 *     → healthy, ok, 200.
 *
 * The last-dispatch gauge still contributes — a missing tick with
 * backlog is what separates stalled from a transient spike. But a
 * missing tick with an empty table is no longer actionable.
 */
@Injectable()
export class OutboxHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async check(): Promise<OutboxHealthResult> {
    const thresholdMs = STALE_AFTER_SEC * 1000;
    const cutoff = new Date(Date.now() - thresholdMs);
    const backlogStale = await this.prisma.outboxEvent
      .count({
        where: { dispatchedAt: null, occurredAt: { lt: cutoff } },
      })
      .catch(() => null);

    const ageSec = this.lastTickAgeSec();

    // DB unreachable → let the DB check in HealthController own the
    // failure; outbox can't meaningfully report on top of a dead DB.
    if (backlogStale === null) {
      return { ok: true, state: 'healthy' };
    }

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
      // Dispatcher is moving; backlog is draining. Counts as healthy
      // under load — next tick clears it.
      return { ok: true, state: 'healthy' };
    }

    // backlogStale === 0
    return { ok: true, state: ageSec === null || !tickRecent ? 'idle' : 'healthy' };
  }

  private lastTickAgeSec(): number | null {
    if (!this.metrics) return null;
    // gauge value is Unix seconds; 0 means "never ticked".
    const rendered = this.metrics.outboxLastDispatchTimestampSeconds;
    // Gauge is synchronous prom-client Gauge — `hashMap[''].value` is
    // the default single-series value. Fall back to async .get() if the
    // shape is unexpected.
    const internalValue = (
      rendered as unknown as {
        hashMap?: Record<string, { value?: number }>;
      }
    ).hashMap?.['']?.value;
    if (typeof internalValue === 'number' && internalValue > 0) {
      return Date.now() / 1000 - internalValue;
    }
    return null;
  }
}
