import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import {
  MESSAGE_REACTION_UPDATED,
  type MessageReactionUpdatedPayload,
} from '../messages/events/message-events';

/**
 * S39 (FR-RE02 / D05): 메시지당 고유 이모지 반응 종류 상한(Discord parity).
 * 이미 존재하는 이모지를 토글 추가하는 것은 신규 *종류* 가 아니므로 한도와
 * 무관하다 — INSERT 가 실제로 새 행을 만들 때만 종류 수를 검사한다.
 */
export const MAX_REACTION_KINDS = 20;

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
   * S39 (FR-RE01 / D05): single-call **toggle**. POST /messages/:id/reactions
   * 가 이 메서드 하나로 추가↔제거를 처리한다 — 단일 $transaction 안에서 caller 의
   * (messageId, userId, emoji) 행 존재 여부를 보고 있으면 DELETE, 없으면 INSERT 한다.
   * 응답은 항상 200 + 현재 집계({ emoji, count, byMe }). Channel ACL 은 컨트롤러가
   * 이 메서드 호출 전에 검사한다.
   *
   * FR-RE02: INSERT 경로에서만 D12 FR-RM16 동시성 패턴을 적용한다 —
   * `ON CONFLICT DO NOTHING` 후 단일 tx 내 `COUNT(DISTINCT emoji) … FOR UPDATE`
   * 로 고유 이모지 종류가 MAX_REACTION_KINDS(20)를 초과하면 방금 삽입한 행을
   * DELETE 한 뒤 REACTION_LIMIT_REACHED(409)로 거부한다. advisory lock 미사용.
   *
   * 어느 경로든 성공 시 message.reaction.updated outbox 1건을 발행한다(옵션 B —
   * subscriber 가 재집계 + users[5] enrichment 후 reaction:updated 로 fanout).
   */
  async add(
    messageId: string,
    channelId: string,
    workspaceId: string | null,
    userId: string,
    rawEmoji: string,
  ): Promise<{ emoji: string; count: number; byMe: boolean }> {
    const emoji = validateEmoji(rawEmoji);
    return this.prisma.$transaction(async (tx) => {
      // Confirm the message still exists + is in this channel (FR-RE06: 삭제
      // 메시지는 deletedAt:null 필터로 매칭되지 않아 404 로 거부된다).
      const message = await tx.message.findFirst({
        where: { id: messageId, channelId, deletedAt: null },
        select: { id: true },
      });
      if (!message) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found in channel');
      }

      // 토글 분기: 내 반응이 이미 있으면 제거, 없으면 추가.
      const existing = await tx.messageReaction.findUnique({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
        select: { messageId: true },
      });

      let byMe: boolean;
      if (existing) {
        await tx.messageReaction.delete({
          where: { messageId_userId_emoji: { messageId, userId, emoji } },
        });
        byMe = false;
      } else {
        // FR-RE02 (D12 FR-RM16 패턴): 새 *종류* 추가 경로. 동시 distinct-emoji
        // INSERT 가 한도(20)를 넘어 통과하는 phantom 을 막으려면 공유 직렬화 앵커가
        // 필요하다. MessageReaction 행 자체는 INSERT 시점에 존재하지 않아 서로
        // 다른 emoji 끼리는 잠글 행이 겹치지 않으므로(READ COMMITTED 에서 각 tx 가
        // 서로의 미커밋 INSERT 를 못 봄), 부모 Message 행을 FOR NO KEY UPDATE 로
        // 잠가 이 메시지에 대한 모든 신규-종류 토글을 직렬화한다(FK 참조를 막지
        // 않는 NO KEY 잠금 — advisory lock 미사용). 잠금 획득 후 ON CONFLICT
        // DO NOTHING 으로 INSERT 하고(동일 (msg,user,emoji) 동시 재시도 흡수),
        // 단일 tx 내 COUNT(DISTINCT emoji) 로 종류 수를 센다. 초과 시 방금 삽입한
        // 행을 DELETE 하고 409 로 거부한다.
        await tx.$executeRaw(Prisma.sql`
          SELECT id FROM "Message" WHERE id = ${messageId}::uuid FOR NO KEY UPDATE
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MessageReaction" ("id", "messageId", "userId", emoji, "createdAt")
          VALUES (gen_random_uuid(), ${messageId}::uuid, ${userId}::uuid, ${emoji}, NOW())
          ON CONFLICT ("messageId", "userId", emoji) DO NOTHING
        `);
        const kindRows = await tx.$queryRaw<{ kinds: bigint }[]>(Prisma.sql`
          SELECT COUNT(DISTINCT emoji)::bigint AS kinds
            FROM "MessageReaction"
           WHERE "messageId" = ${messageId}::uuid
        `);
        const distinctKinds = Number(kindRows[0]?.kinds ?? 0n);
        if (distinctKinds > MAX_REACTION_KINDS) {
          // 방금 삽입한(이 emoji 종류를 한도 초과로 만든) 행만 되돌린다.
          await tx.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
          throw new DomainError(
            ErrorCode.REACTION_LIMIT_REACHED,
            `message already has the maximum of ${MAX_REACTION_KINDS} reaction kinds`,
          );
        }
        byMe = true;
      }

      const count = await tx.messageReaction.count({ where: { messageId, emoji } });
      const payload: MessageReactionUpdatedPayload = {
        workspaceId,
        channelId,
        messageId,
        actorId: userId,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: messageId,
        eventType: MESSAGE_REACTION_UPDATED,
        payload,
      });
      return { emoji, count, byMe };
    });
  }

  /**
   * Remove the caller's own reaction (FR-RE08: OWNER 의 타인 반응 제거는 S40).
   * No-op (still 204) if the row doesn't exist so the UI can be optimistic
   * without a precondition check. 행을 실제로 지운 경우에만 reaction.updated
   * outbox 1건을 발행한다(옵션 B 단일 이벤트).
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
      const payload: MessageReactionUpdatedPayload = {
        workspaceId,
        channelId,
        messageId,
        actorId: userId,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: messageId,
        eventType: MESSAGE_REACTION_UPDATED,
        payload,
      });
    });
  }
}
