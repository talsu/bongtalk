import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { MetricsService } from '../../observability/metrics/metrics.service';
import { captureTraceparent } from '../../observability/otel/propagation';
import type { OutboxRecordInput, OutboxTxClient } from './outbox.types';

/**
 * `record(tx, input)` must be called from within a Prisma `$transaction`
 * callback so the outbox row becomes visible at the same commit as the
 * business write. If no tx is passed, we fall back to the root PrismaClient
 * (fine for single-statement writes — the client is its own implicit tx).
 *
 * Trace context: we capture the current W3C traceparent at record time and
 * embed it in the payload so the dispatcher can restore the span chain when
 * it fires the event seconds/minutes later — bridging the async gap.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async record(tx: OutboxTxClient | null, input: OutboxRecordInput): Promise<string> {
    const client = tx ?? (this.prisma as unknown as OutboxTxClient);
    const carrier = captureTraceparent();
    const payload = {
      ...((input.payload as Record<string, unknown>) ?? {}),
      __trace: carrier,
    };
    const row = await client.outboxEvent.create({
      data: {
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    this.metrics?.outboxEventsRecordedTotal.labels(input.eventType).inc();
    return row.id;
  }
}
