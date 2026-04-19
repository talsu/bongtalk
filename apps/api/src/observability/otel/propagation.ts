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
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('qufox-manual');
  const span = tracer.startSpan(name, { attributes: attrs, kind: SpanKind.INTERNAL });
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
