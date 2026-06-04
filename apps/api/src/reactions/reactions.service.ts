import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PERMISSIONS, REACTION_USERS_MAX_LIMIT } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import { encodeCursor, decodeCursor } from '../messages/cursor/cursor';
import {
  MESSAGE_REACTION_UPDATED,
  MESSAGE_REACTION_CLEARED,
  type MessageReactionUpdatedPayload,
  type MessageReactionClearedPayload,
} from '../messages/events/message-events';

/**
 * S40 (FR-RE07): 카탈로그(shared-types PERMISSIONS) 의 ADD_REACTIONS 비트(0x20)를
 * Number 로 상수화한다. 채널 권한 override 의 allow/deny mask 는 카탈로그 비트로
 * 저장되므로(isValidPermissionMaskNumber 가 ALL_PERMISSIONS 범위로 검증), 반응
 * 추가 경로에서 effective mask 의 이 비트를 직접 검사한다.
 *
 * ⚠️ API enum `Permission`(apps/api/src/auth/permissions.ts)은 비트 5(0x20)가
 * MANAGE_CHANNEL 로 카탈로그(ADD_REACTIONS=0x20)와 어긋나 있다 — 이는 기존 "권한
 * 2중화"(D12 권한 수렴 대상) carryover 다. S40 은 API enum 을 수정하지 않고,
 * override 가 카탈로그 비트로 저장된다는 사실에 기대 카탈로그 ADD_REACTIONS 비트를
 * 직접 검사한다(API enum↔카탈로그 정합은 D12 범위).
 */
export const ADD_REACTIONS_BIT = Number(PERMISSIONS.ADD_REACTIONS); // 0x20 = 32

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

/**
 * S41 (FR-EM06 / FR-RC20): 커스텀 이모지 슬러그 패턴 `:name:` (name = 2-32자
 * 소문자·숫자·언더스코어 — CustomEmoji 이름 규칙과 동일). 매칭되면 커스텀 이모지
 * 반응으로 분기해 워크스페이스 소속 CustomEmoji 존재를 검증한다.
 */
const CUSTOM_EMOJI_TOKEN_RE = /^:([a-z0-9_]{2,32}):$/;

/** 토큰에서 슬러그(name)를 뽑는다. 커스텀 토큰이 아니면 null. */
function customEmojiName(token: string): string | null {
  const m = CUSTOM_EMOJI_TOKEN_RE.exec(token);
  return m ? m[1] : null;
}

/**
 * 유니코드 반응의 형태 검증. 커스텀 이모지 토큰(`:name:`)은 이 검증을 거치지
 * 않는다 — 토큰 자체가 codepoint 수를 초과할 수 있고, 길이는 64바이트(VarChar)
 * 한도 안이며, 존재 검증은 별도 워크스페이스 조회로 한다.
 */
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
  // S41: 커스텀 이모지 토큰은 codepoint 한도 검증을 건너뛴다(슬러그라 길 수 있음).
  if (customEmojiName(trimmed) !== null) {
    return trimmed;
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
   * S62 (FR-RM16 확인): 위 카노니컬 패턴(단일 $transaction · 부모 Message FOR NO KEY
   * UPDATE 직렬화 앵커 · ON CONFLICT DO NOTHING · COUNT(DISTINCT) 초과 시 DELETE+409 ·
   * advisory lock 금지)이 D05(FR-RE02)에서 이미 구현돼 있어 S62 추가 변경이 불필요함을
   * 확인했다. 에러코드는 REACTION_LIMIT_REACHED(스펙 표기 MAX_REACTIONS_REACHED 와 동일
   * 의미 · 기존 ErrorCode 유지).
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
    // S40 (FR-RE07): 컨트롤러가 effective mask 의 카탈로그 ADD_REACTIONS 비트를
    // 미리 계산해 넘긴다. 토글이 INSERT(새 반응 추가)로 분기할 때만 이 플래그를
    // 검사한다 — 제거(toggle off)는 권한과 무관하므로 false 여도 통과한다.
    canAddReaction: boolean,
    // S63 (FR-RM07) + fix-forward (B-3): 호출자가 워크스페이스 채널 타임아웃 상태를
    // 미리 판정해 넘긴다. INSERT(추가) 분기에서만 MEMBER_TIMED_OUT(403)으로 거부하고,
    // 제거(toggle off)는 음소거 중에도 허용한다(FR-RM07 은 "추가 차단"). 기본 false 로
    // DM/비-타임아웃 경로는 영향 없다.
    isTimedOut = false,
    // S71 (FR-W07 / Fork-C): 호출자가 규칙 미동의 + 규칙 존재를 미리 판정해 넘긴다. INSERT
    // (추가) 분기에서만 RULES_NOT_ACCEPTED(403)으로 거부하고, 제거(toggle off)는 허용한다
    // (타임아웃 게이트 일관). 기본 false 로 DM/규칙 없는 워크스페이스는 영향 없다.
    isRulesBlocked = false,
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
        // S63 (FR-RM07) + fix-forward (B-3): 추가(INSERT) 분기에서만 타임아웃을 게이트
        // 한다. 음소거 중인 사용자가 *새* 반응을 다는 것은 막지만, 토글이 제거 분기였다면
        // 위에서 이미 처리돼 여기 도달하지 않으므로 자기 반응 제거는 음소거 중에도 허용된다.
        if (isTimedOut) {
          throw new DomainError(
            ErrorCode.MEMBER_TIMED_OUT,
            '타임아웃 중에는 반응을 추가할 수 없습니다',
          );
        }
        // S71 (FR-W07 / Fork-C): 규칙 미동의 게이트(추가 분기 한정).
        if (isRulesBlocked) {
          throw new DomainError(
            ErrorCode.RULES_NOT_ACCEPTED,
            '규칙에 동의한 후 반응을 추가할 수 있습니다',
          );
        }
        // FR-RE07: 추가(INSERT) 경로에서만 ADD_REACTIONS 권한을 게이트한다. READ 는
        // 컨트롤러가 이미 통과시켰고, 여기서 effective mask 에 카탈로그 ADD_REACTIONS
        // 비트가 없으면(override DENY 등) 403 으로 거부한다.
        if (!canAddReaction) {
          throw new DomainError(ErrorCode.FORBIDDEN, 'reaction add is denied on this channel');
        }
        // S41 (FR-EM06 / FR-RC20): 커스텀 이모지 토큰(`:name:`)이면 채널의
        // 워크스페이스에 그 이름의 CustomEmoji 가 존재하는지 검증하고 그 id 를
        // 잡는다 — 없으면(혹은 DM 채널이라 workspaceId 가 null 이면) 거부한다.
        // 유니코드 반응이면 customEmojiId 는 null 로 남는다.
        const customName = customEmojiName(emoji);
        let customEmojiId: string | null = null;
        if (customName !== null) {
          if (workspaceId === null) {
            throw new DomainError(
              ErrorCode.CUSTOM_EMOJI_NOT_FOUND,
              'custom emoji reactions are not available in this channel',
            );
          }
          const ce = await tx.customEmoji.findUnique({
            where: { workspaceId_name: { workspaceId, name: customName } },
            select: { id: true },
          });
          if (!ce) {
            throw new DomainError(
              ErrorCode.CUSTOM_EMOJI_NOT_FOUND,
              `:${customName}: is not a custom emoji in this workspace`,
            );
          }
          customEmojiId = ce.id;
        }
        // FR-RE02 (D12 FR-RM16 패턴): 새 *종류* 추가 경로. 동시 distinct-emoji
        // INSERT 가 한도(20)를 넘어 통과하는 phantom 을 막으려면 공유 직렬화 앵커가
        // 필요하다. MessageReaction 행 자체는 INSERT 시점에 존재하지 않아 서로
        // 다른 emoji 끼리는 잠글 행이 겹치지 않으므로(READ COMMITTED 에서 각 tx 가
        // 서로의 미커밋 INSERT 를 못 봄), 부모 Message 행을 FOR NO KEY UPDATE 로
        // 잠가 이 메시지에 대한 모든 신규-종류 토글을 직렬화한다(FK 참조를 막지
        // 않는 NO KEY 잠금 — advisory lock 미사용). 잠금 획득 후 ON CONFLICT
        // DO NOTHING 으로 INSERT 하고(동일 (msg,user,emoji) 동시 재시도 흡수),
        // 단일 tx 내 COUNT(DISTINCT emoji) 로 종류 수를 센다. 초과 시 방금 삽입한
        // 행을 DELETE 하고 409 로 거부한다. S41: customEmojiId 컬럼도 함께 삽입한다.
        await tx.$executeRaw(Prisma.sql`
          SELECT id FROM "Message" WHERE id = ${messageId}::uuid FOR NO KEY UPDATE
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MessageReaction" ("id", "messageId", "userId", emoji, "customEmojiId", "createdAt")
          VALUES (gen_random_uuid(), ${messageId}::uuid, ${userId}::uuid, ${emoji}, ${customEmojiId}::uuid, NOW())
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

  /**
   * S40 (FR-RE08): 특정 사용자(targetUserId)의 한 이모지 반응을 actorId 가 제거한다.
   *
   *   - actorId === targetUserId  : 자기 반응 제거. 항상 허용(toggle off 와 동치).
   *   - actorId !== targetUserId  : 타인 반응 제거. 워크스페이스 role 이 OWNER/ADMIN
   *                                 일 때만 허용하고, MEMBER 는 403(FORBIDDEN)이다.
   *                                 DM 채널(workspaceId=null)은 워크스페이스 role 이
   *                                 없으므로 타인 제거를 항상 거부한다.
   *
   * 채널 READ ACL 은 컨트롤러가 이 메서드 호출 전에 검사한다. 행을 실제로 지운
   * 경우에만 reaction.updated outbox 1건을 발행한다(옵션 B 단일 이벤트 — 집계 fanout).
   * 대상 행이 없으면 no-op(204) 로 둔다(낙관 UI 대비, remove 선례).
   */
  async removeByActor(
    messageId: string,
    channelId: string,
    workspaceId: string | null,
    actorId: string,
    targetUserId: string,
    rawEmoji: string,
  ): Promise<void> {
    const emoji = validateEmoji(rawEmoji);
    if (actorId !== targetUserId) {
      // 타인 반응 제거: OWNER/ADMIN 만. workspaceId 가 null(DM)이면 role 부재 → 거부.
      if (workspaceId === null) {
        throw new DomainError(
          ErrorCode.FORBIDDEN,
          'only workspace owners/admins may remove others’ reactions',
        );
      }
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: actorId } },
        select: { role: true },
      });
      if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) {
        throw new DomainError(
          ErrorCode.FORBIDDEN,
          'only workspace owners/admins may remove others’ reactions',
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.messageReaction.deleteMany({
        where: { messageId, userId: targetUserId, emoji },
      });
      if (deleted.count === 0) return;
      const payload: MessageReactionUpdatedPayload = {
        workspaceId,
        channelId,
        messageId,
        actorId,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: messageId,
        eventType: MESSAGE_REACTION_UPDATED,
        payload,
      });
    });
  }

  /**
   * S40 (FR-RE09): 메시지의 *모든* 반응을 OWNER/ADMIN 이 일괄 삭제한다. 권한은
   * 컨트롤러가 OWNER/ADMIN 게이트로 검사한 뒤 호출한다(서비스는 데이터 변경 +
   * 이벤트만 책임진다). deleteMany(messageId) 로 전체 행을 비우고, 실제로 1행
   * 이상 지운 경우에만 message.reaction.cleared outbox 1건을 발행한다(subscriber 가
   * 콜론 wire reaction:cleared 로 변환해 채널 룸 fanout). 이미 반응이 없으면 no-op.
   */
  async clearAll(
    messageId: string,
    channelId: string,
    workspaceId: string | null,
    actorId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.messageReaction.deleteMany({ where: { messageId } });
      if (deleted.count === 0) return;
      const payload: MessageReactionClearedPayload = {
        workspaceId,
        channelId,
        messageId,
        actorId,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: messageId,
        eventType: MESSAGE_REACTION_CLEARED,
        payload,
      });
    });
  }

  /**
   * S40 (FR-RE05): 한 이모지에 반응한 *전체* reactor 목록을 cursor 페이지네이션으로
   * 반환한다. 정렬은 (createdAt ASC, id ASC) — 최초 반응자부터 안정 정렬한다.
   * 메시지 목록과 동일한 (createdAt, id) 튜플 row-value 비교 + opaque base64url
   * 커서를 재사용한다(decodeCursor/encodeCursor). limit 은 컨트롤러(Zod)가 1..100
   * 으로 강제하나, 방어적으로 여기서도 max 로 클램프한다. 채널 READ ACL 은
   * 컨트롤러가 이 메서드 호출 전에 검사한다.
   *
   * `nextCursor` 는 limit+1 을 fetch 해 다음 페이지 존재 여부를 판별하는 흔한
   * 패턴이다 — limit 개를 넘게 받으면 마지막(초과) 행을 잘라내고 그 직전 행으로
   * 커서를 만든다(MessageReaction.id 는 @db.Uuid, createdAt 은 timestamptz).
   *
   * ⚠️ S40 fix-forward (BLOCKER): tie-breaker id 는 반드시 **MessageReaction.id**
   * (r."id")여야 한다. 종전엔 SELECT 가 `u.id`(User.id)를 "id" 로 별칭해 cursor 에
   * User.id 를 인코딩한 반면, ORDER BY·cursor 비교는 `r."id"`(Reaction.id)를 썼다 —
   * 정렬 키와 커서 키가 서로 다른 id 공간이라, 같은 밀리초에 여러 reactor 가 몰리면
   * 페이지 경계가 어긋나 다음 페이지에 직전 행이 중복으로 끼어들었다(FR-RE05
   * 페이지네이션 테스트 RED). 이제 cursor 의 tie-breaker 를 Reaction.id 로 통일하고,
   * 응답의 reactor 식별자(users[].id)는 별도 컬럼(userId)으로 분리해 그대로 User.id 를
   * 싣는다.
   */
  async listEmojiUsers(
    messageId: string,
    rawEmoji: string,
    limit: number,
    cursor?: string,
  ): Promise<{ users: { id: string; username: string | null }[]; nextCursor: string | null }> {
    const emoji = validateEmoji(rawEmoji);
    const take = Math.min(Math.max(1, Math.trunc(limit)), REACTION_USERS_MAX_LIMIT);
    const decoded = cursor ? decodeCursor(cursor) : null;

    // ⚠️ 정밀도 정합: cursor.createdAt 은 ISO 밀리초 정밀도(encodeCursor 가
    // toISOString())지만, MessageReaction.createdAt 은 DB now() 의 마이크로초
    // 정밀도다. 키셋 비교를 raw createdAt 으로 하면, 같은 밀리초·다른 마이크로초
    // 행이 truncated cursor 보다 "크다"고 판정돼 다음 페이지에 중복으로 끼어든다.
    // 그래서 정렬·비교·커서 인코딩을 모두 **밀리초로 truncate** 한 createdAt 으로
    // 통일한다(date_trunc('milliseconds', …)). reactionId 가 2차 tie-breaker 라 동일
    // 밀리초 내에서도 안정·중복 없는 페이지네이션이 보장된다(메시지 커서는 행을
    // 밀리초 정렬로 시드해 이 문제가 없었음 — 반응은 DB now() 라 명시 truncate 필요).
    const cursorClause = decoded
      ? Prisma.sql`AND (date_trunc('milliseconds', r."createdAt"), r."id") > (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { reactionId: string; userId: string; username: string | null; createdAtMs: Date }[]
    >(Prisma.sql`
      SELECT r.id                                        AS "reactionId",
             u.id                                        AS "userId",
             u.username                                  AS "username",
             date_trunc('milliseconds', r."createdAt")   AS "createdAtMs"
        FROM "MessageReaction" r
        JOIN "User" u ON u.id = r."userId"
       WHERE r."messageId" = ${messageId}::uuid
         AND r.emoji = ${emoji}
         ${cursorClause}
       ORDER BY date_trunc('milliseconds', r."createdAt") ASC, r."id" ASC
       LIMIT ${take + 1}
    `);

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page.length > 0 ? page[page.length - 1] : null;
    const nextCursor =
      hasMore && last
        ? encodeCursor({ id: last.reactionId, createdAt: last.createdAtMs.toISOString() })
        : null;
    return {
      users: page.map((r) => ({ id: r.userId, username: r.username ?? null })),
      nextCursor,
    };
  }
}
