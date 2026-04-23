import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';

export const REACTION_ADDED = 'message.reaction.added';
export const REACTION_REMOVED = 'message.reaction.removed';

/**
 * Task-013-B: message reactions. `emoji` is stored as the literal
 * unicode string the client sent (or picked); we cap codepoint-count
 * at 4 so a single human-perceivable emoji fits (1 codepoint for a
 * basic emoji, up to 4 for ZWJ-joined family / profession sequences)
 * but a pasted paragraph doesn't. VARCHAR(64) in the DB is the hard
 * upper bound.
 */
const MAX_EMOJI_CODEPOINTS = 4;
const MAX_EMOJI_BYTES = 64;

function validateEmoji(raw: string): string {
  if (typeof raw !== 'string') {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'emoji must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'emoji cannot be empty');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_EMOJI_BYTES) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, `emoji exceeds ${MAX_EMOJI_BYTES} bytes`);
  }
  const codepoints = [...trimmed];
  if (codepoints.length > MAX_EMOJI_CODEPOINTS) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `emoji exceeds ${MAX_EMOJI_CODEPOINTS} codepoints`,
    );
  }
  return trimmed;
}

@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Idempotent add. Repeating the same (messageId, userId, emoji)
   * returns the existing row — no 409. Channel ACL check is done by
   * the controller before this method runs.
   */
  async add(
    messageId: string,
    channelId: string,
    workspaceId: string | null,
    userId: string,
    rawEmoji: string,
  ): Promise<{ emoji: string; count: number; byMe: true; created: boolean }> {
    const emoji = validateEmoji(rawEmoji);
    return this.prisma.$transaction(async (tx) => {
      // Confirm the message still exists + is in this channel.
      const message = await tx.message.findFirst({
        where: { id: messageId, channelId, deletedAt: null },
        select: { id: true },
      });
      if (!message) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found in channel');
      }

      let created = true;
      try {
        await tx.messageReaction.create({ data: { messageId, userId, emoji } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          created = false; // idempotent: row already exists
        } else {
          throw err;
        }
      }

      const count = await tx.messageReaction.count({ where: { messageId, emoji } });
      if (created) {
        await this.outbox.record(tx, {
          aggregateType: 'Message',
          aggregateId: messageId,
          eventType: REACTION_ADDED,
          payload: { messageId, channelId, workspaceId, userId, emoji, count },
        });
      }
      return { emoji, count, byMe: true, created };
    });
  }

  /**
   * Remove the caller's own reaction. No-op (and still emits 204) if
   * the row doesn't exist so the UI can be optimistic without a
   * precondition check.
   */
  async remove(
    messageId: string,
    channelId: string,
    workspaceId: string | null,
    userId: string,
    rawEmoji: string,
  ): Promise<void> {
    const emoji = validateEmoji(rawEmoji);
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.messageReaction.deleteMany({
        where: { messageId, userId, emoji },
      });
      if (deleted.count === 0) return;
      const count = await tx.messageReaction.count({ where: { messageId, emoji } });
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: messageId,
        eventType: REACTION_REMOVED,
        payload: { messageId, channelId, workspaceId, userId, emoji, count },
      });
    });
  }
}
