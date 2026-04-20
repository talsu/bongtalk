import {
  context,
  propagation,
  trace,
  type Context,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';

/**
 * Small wrappers around the @opentelemetry/api so business code that wants
 * to bridge an async gap (outbox) doesn't import the heavy propagation API
 * directly. Only W3C traceparent + tracestate are captured — baggage is
 * intentionally skipped to avoid accidental PII carry-over.
 */

export function captureTraceparent(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function restoreContext<T>(
  carrier: Record<string, string> | null | undefined,
  run: (ctx: Context) => T,
): T {
  if (!carrier) return run(context.active());
  const restored = propagation.extract(context.active(), carrier);
  return context.with(restored, () => run(restored));
}

/**
 * Helper for manual spans in places where auto-instrumentation doesn't reach
 * (Socket.IO emits, outbox dispatch). Starts → records exceptions → ends.
 *
 * task-016-B (009-nit-2 closure): `attrs` runs through a redaction
 * pass so accidentally passing a PII-ish key (`password`, `email`,
 * `content`, etc.) drops the value instead of leaking it to the
 * OTEL exporter. Developer-side contract is still "don't pass
 * sensitive data", but defense-in-depth.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const safe = sanitizeSpanAttrs(attrs);
  const tracer = trace.getTracer('qufox-manual');
  const span = tracer.startSpan(name, { attributes: safe, kind: SpanKind.INTERNAL });
  try {
    const out = await fn();
    span.end();
    return out;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message ?? '' });
    span.end();
    throw err;
  }
}

function sanitizeSpanAttrs(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (redactedAttributes.forbidden.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export const redactedAttributes = {
  /** Never put these on span attributes. */
  forbidden: new Set([
    'content',
    'password',
    'passwordHash',
    'accessToken',
    'refreshToken',
    'token',
    'email',
    'authorization',
    'cookie',
  ]),
} as const;
