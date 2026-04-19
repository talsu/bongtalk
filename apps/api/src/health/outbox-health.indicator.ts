import { Inject, Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../observability/metrics/metrics.service';

const STALE_AFTER_SEC = 10;

/**
 * Reads the metric gauge `outbox_last_dispatch_timestamp_seconds` (set by
 * the dispatcher on every successful tick) to decide whether the dispatcher
 * is healthy. If the metrics module isn't wired (integration tests), we fall
 * back to assuming healthy — we don't want health checks to fail because
 * metrics are disabled.
 */
@Injectable()
export class OutboxHealthIndicator {
  constructor(@Optional() @Inject(MetricsService) private readonly metrics?: MetricsService) {}

  async check(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.metrics) return { ok: true };
    const rendered = await this.metrics.outboxLastDispatchTimestampSeconds.get();
    const sample = rendered.values[0];
    if (!sample || typeof sample.value !== 'number' || sample.value === 0) {
      // Never dispatched yet — boot state. Treat as OK; the dispatcher will
      // fire within the next tick (250ms default) and fill the gauge.
      return { ok: true };
    }
    const nowSec = Date.now() / 1000;
    const ageSec = nowSec - sample.value;
    if (ageSec > STALE_AFTER_SEC) {
      return { ok: false, reason: `stalled (${ageSec.toFixed(1)}s since last dispatch)` };
    }
    return { ok: true };
  }
}
