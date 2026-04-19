import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import type { OutboxRecordInput, OutboxTxClient } from './outbox.types';

/**
 * `record(tx, input)` must be called from within a Prisma `$transaction`
 * callback so the outbox row becomes visible at the same commit as the
 * business write. If no tx is passed, we fall back to the root PrismaClient
 * (fine for single-statement writes — the client is its own implicit tx).
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: OutboxTxClient | null, input: OutboxRecordInput): Promise<string> {
    const client = tx ?? (this.prisma as unknown as OutboxTxClient);
    const row = await client.outboxEvent.create({
      data: {
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
    return row.id;
  }
}
