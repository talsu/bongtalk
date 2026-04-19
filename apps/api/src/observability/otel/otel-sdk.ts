import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
// sdk-node re-exports the trace-base samplers under its sampling API; we
// import them through the package we already depend on to avoid a second
// peer-dependency surface.
import { TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-node';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { buildResource } from './resource';

let sdk: NodeSDK | null = null;

/**
 * Bootstraps the OpenTelemetry SDK with HTTP/express/pg/ioredis/NestJS
 * auto-instrumentation + OTLP HTTP exporter. **Fail-open** by design —
 * every error path swallows and logs; this layer must never break the app.
 *
 * Sampling: parent-based TraceIdRatio(0.1) by default. Errors are marked
 * `SpanStatus.ERROR` regardless; to guarantee they're sampled regardless of
 * the ratio we rely on the @opentelemetry/api convention of applying the
 * sampler at root-span start — downstream teams with a tail sampler (OTEL
 * collector) can promote error traces at export time.
 */
export function startOtel(): void {
  if (sdk) return;
  if (process.env.METRICS_ENABLED === 'false') return; // master switch

  try {
    // Surface SDK errors at warn level so we see real problems but the
    // 'internal retry' chatter doesn't flood logs.
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

    const ratio = Number(process.env.OTEL_SAMPLER_RATIO ?? 0.1);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    sdk = new NodeSDK({
      resource: buildResource(),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 0.1),
      }),
      // When no OTLP endpoint is configured we STILL start the SDK so
      // instrumentation hooks fire (and context propagates across async
      // boundaries for our own log correlation) — the exporter just becomes
      // a noop sink.
      traceExporter: endpoint
        ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` })
        : undefined,
      instrumentations: [
        getNodeAutoInstrumentations({
          // Noisy and low-signal: fs I/O. The others are keepers.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          // HTTP instrumentation: do NOT mutate live request headers.
          // An earlier version of this hook deleted `cookie` and
          // `authorization` inside `requestHook` to keep them off span
          // attributes — but `requestHook` fires BEFORE the handler chain,
          // so the JwtStrategy + refresh-cookie middleware then saw empty
          // headers and every authenticated call 401'd in prod.
          // The default instrumentation does NOT capture request/response
          // headers, so simply omitting the hook is safe. If we later want
          // to expose headers on spans, use `headersToSpanAttributes` with
          // an allowlist (never a blocklist on req.headers itself).
          '@opentelemetry/instrumentation-http': {},
        }),
      ],
    });
    sdk.start();
    // eslint-disable-next-line no-console
    console.log(
      `[otel] started (sampler=${ratio}, exporter=${endpoint ?? 'noop'}) service=${process.env.OTEL_SERVICE_NAME ?? 'qufox-api'}`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[otel] SDK failed to start; continuing without tracing', err);
    sdk = null;
  }
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* swallow */
  } finally {
    sdk = null;
  }
}
