import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.module';

type OutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
};

/**
 * Polls `OutboxEvent` every `OUTBOX_DISPATCH_INTERVAL_MS` and fans each
 * claimed row out through `EventEmitter2`. Uses Postgres `FOR UPDATE SKIP
 * LOCKED` so multiple API replicas share the table without double-dispatch.
 *
 * Delivery semantics: **at-least-once**. Subscribers must treat the emitted
 * event's `id` as the idempotency key.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private currentTick: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  get intervalMs(): number {
    return Number(process.env.OUTBOX_DISPATCH_INTERVAL_MS ?? 250);
  }
  get batchSize(): number {
    return Number(process.env.OUTBOX_BATCH_SIZE ?? 50);
  }
  get maxAttempts(): number {
    return Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10);
  }

  async onModuleInit(): Promise<void> {
    // Startup warning for any rows that failed at least once on a previous run.
    const stuck = await this.prisma.outboxEvent.count({
      where: { dispatchedAt: null, attempts: { gt: 0 } },
    });
    if (stuck > 0) {
      this.logger.warn(
        `[outbox] ${stuck} event(s) with attempts > 0 still pending — will retry`,
      );
    }
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Wait for the in-flight tick to finish so we don't orphan a claim.
    if (this.currentTick) {
      await this.currentTick.catch(() => undefined);
    }
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /** Pause the automatic polling loop without affecting manual `drain()`. */
  pausePolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Manually invoke one tick — used by integration tests to drive the
   * dispatcher deterministically. Bypasses the `stopping` guard so tests can
   * still drain after explicit shutdown simulation.
   */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const promise = this.processOnce().finally(() => {
      this.running = false;
    });
    this.currentTick = promise;
    return promise;
  }

  private async tick(): Promise<number> {
    if (this.running || this.stopping) return 0;
    this.running = true;
    const promise = this.processOnce().finally(() => {
      this.running = false;
    });
    this.currentTick = promise;
    return promise;
  }

  private async processOnce(): Promise<number> {
    // Claim a batch atomically via SKIP LOCKED. We UPDATE with RETURNING
    // `attempts` incremented so a concurrent dispatcher sees the claim.
    const claimed = await this.prisma.$queryRawUnsafe<OutboxRow[]>(
      `WITH claimed AS (
         SELECT id
           FROM "OutboxEvent"
          WHERE "dispatchedAt" IS NULL
            AND attempts < $1
          ORDER BY "occurredAt"
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE "OutboxEvent" o
          SET attempts = o.attempts + 1
         FROM claimed
        WHERE o.id = claimed.id
    RETURNING o.id, o."aggregateType", o."aggregateId", o."eventType",
              o.payload, o."occurredAt", o.attempts`,
      this.maxAttempts,
      this.batchSize,
    );

    if (claimed.length === 0) return 0;

    let dispatched = 0;
    for (const row of claimed) {
      // Wrap the payload with event id + metadata so subscribers can dedupe by
      // `event.id` — this is the explicit at-least-once contract.
      const envelope = {
        ...(typeof row.payload === 'object' && row.payload !== null
          ? (row.payload as Record<string, unknown>)
          : { payload: row.payload }),
        id: row.id,
        type: row.eventType,
        occurredAt: row.occurredAt.toISOString(),
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
      };
      try {
        await this.emitter.emitAsync(row.eventType, envelope);
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { dispatchedAt: new Date(), lastError: null },
        });
        dispatched++;
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { lastError: message },
        });
        this.logger.warn(
          `[outbox] dispatch failed id=${row.id} type=${row.eventType} attempts=${row.attempts} err=${message}`,
        );
      }
    }
    return dispatched;
  }
}
