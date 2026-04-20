import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type Registry as RegistryType,
} from 'prom-client';

/**
 * Webhook / deploy pipeline metrics. Exposed at
 * `GET /internal/metrics` with a 127.0.0.1-only allowlist (see
 * `server.ts`). Cardinality is bounded — `result` has 3 values,
 * histogram buckets are fixed — so the registry stays small enough to
 * scrape at 15s intervals without back-pressure.
 */
export class DeployMetrics {
  readonly registry: RegistryType;
  readonly deploysTotal: Counter<'result'>;
  readonly deployDuration: Histogram<string>;
  readonly queueDepth: Gauge<string>;
  readonly rollbacksTotal: Counter<string>;

  constructor() {
    this.registry = new Registry();
    // Default process/node metrics (process_cpu, process_resident_memory,
    // nodejs_heap, …) let the dashboard catch the webhook getting OOM'd
    // before the real signal (deploy failures) stops flowing.
    collectDefaultMetrics({ register: this.registry, prefix: 'qufox_webhook_' });

    this.deploysTotal = new Counter({
      name: 'qufox_deploys_total',
      help: 'Total deploys processed by the webhook, labelled by outcome',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });
    // Seed the three labels so /metrics always lists them at 0 even
    // before the first deploy. Prometheus query joins don't like
    // unseen labels appearing mid-window.
    this.deploysTotal.inc({ result: 'ok' }, 0);
    this.deploysTotal.inc({ result: 'fail' }, 0);
    this.deploysTotal.inc({ result: 'rollback' }, 0);

    this.deployDuration = new Histogram({
      name: 'qufox_deploy_duration_seconds',
      help: 'End-to-end deploy wall time from queue pop to runner return',
      buckets: [10, 30, 60, 120, 240, 480],
      registers: [this.registry],
    });

    this.queueDepth = new Gauge({
      name: 'qufox_deploy_queue_depth',
      help: 'Number of pending deploys at snapshot time (0-1 with current single-slot coalesce)',
      registers: [this.registry],
    });

    this.rollbacksTotal = new Counter({
      name: 'qufox_deploy_rollbacks_total',
      help: 'Rollbacks reported by scripts/deploy/rollback.sh via POST /internal/rollback-reported',
      registers: [this.registry],
    });
    this.rollbacksTotal.inc(0);
  }

  expose(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
