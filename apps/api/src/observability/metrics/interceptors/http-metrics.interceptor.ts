import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request } from 'express';
import { MetricsService } from '../metrics.service';

/**
 * Measures every HTTP request: count, latency histogram, in-flight gauge.
 * Route is taken from the Express router (`req.route.path`) which is the
 * template form (`/workspaces/:id/channels/:chid/messages`) — high-cardinality
 * path params never leak into the label space.
 *
 * Non-HTTP contexts (WS handshake, etc.) are skipped via the context-type
 * check.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const start = process.hrtime.bigint();
    const method = this.metrics.bucket('httpMethod', (req.method ?? 'GET').toUpperCase());
    const route = resolveRoute(req);

    this.metrics.httpInFlight.labels(route).inc();

    return next.handle().pipe(
      tap({
        next: () => this.finalize(context, method, route, start),
        error: () => this.finalize(context, method, route, start),
      }),
    );
  }

  private finalize(context: ExecutionContext, method: string, route: string, start: bigint): void {
    const res = context.switchToHttp().getResponse<{ statusCode: number }>();
    const statusClass = this.metrics.bucket(
      'httpStatusClass',
      `${Math.floor((res.statusCode ?? 200) / 100)}xx`,
    );
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    this.metrics.httpRequestsTotal.labels(method, route, statusClass).inc();
    this.metrics.httpRequestDurationSeconds.labels(method, route).observe(durationSec);
    this.metrics.httpInFlight.labels(route).dec();
  }
}

function resolveRoute(req: Request): string {
  // Express 4 exposes the matched route template on `req.route.path`. When
  // the handler is not registered via router (e.g. 404), fall back to
  // 'unknown' — keeps cardinality bounded even for scanners hammering random
  // URLs.
  const route =
    (req as unknown as { route?: { path?: string } }).route?.path ??
    (req as unknown as { baseUrl?: string }).baseUrl;
  if (route) return route;
  return '_unknown';
}
