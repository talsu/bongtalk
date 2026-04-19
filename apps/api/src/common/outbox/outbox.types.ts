/**
 * Domain event "types" accepted by the outbox. Keep this list narrow —
 * security-sensitive events (SESSION_COMPROMISED) intentionally bypass the
 * outbox because they must not wait for the dispatcher's ~250ms interval.
 */
export type OutboxAggregate =
  | 'workspace'
  | 'member'
  | 'invite'
  | 'channel'
  | 'category'
  | 'Message';

export type OutboxRecordInput = {
  aggregateType: OutboxAggregate;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

import type { Prisma } from '@prisma/client';

/** Minimum Prisma surface we need from a transaction client. */
export type OutboxTxClient = {
  outboxEvent: {
    create: (args: {
      data: {
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        payload: Prisma.InputJsonValue;
      };
    }) => Promise<{ id: string }>;
  };
};
