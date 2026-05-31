import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import {
  MessageMentions,
  type MessageType,
  renderSystemMessageTemplate,
  EDIT_HISTORY_CAP,
  type EditHistoryDto,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import type { RichTextRoot } from '@qufox/shared-types';
import { cursorFor, decodeCursor } from './cursor/cursor';
import {
  extractMentions,
  resolveMentionHandles,
  resolveMentionLabelMaps,
} from './mentions/mention-extractor';
import { normalizeMentions } from './mentions/mention-normalizer';
import { processMrkdwn } from './mrkdwn-pipeline';
import { gateEveryoneMention, gateHereMention, type GateActorRole } from './mentions/gate';
import { ThreadSubscriptionsService } from './thread-subscriptions.service';
import {
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_PIN_TOGGLED,
  MESSAGE_THREAD_REPLIED,
  MESSAGE_UPDATED,
  THREAD_REPLY_RECIPIENT_CAP,
  type MessageCreatedPayload,
  type MessageDeletedPayload,
  type MessagePinToggledPayload,
  type MessageThreadRepliedPayload,
  type MessageUpdatedPayload,
} from './events/message-events';
import { MENTION_RECEIVED, type MentionReceivedPayload } from './events/mention-events';

/**
 * First ~140 chars of a message, whitespace-collapsed, for the mention
 * toast snippet. Full content lives on the Message row; the snippet
 * avoids double-storing state while keeping the notification
 * self-contained if the toast arrives before `GET /me/mentions`.
 */
function buildSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 140 ? collapsed.slice(0, 140) + '…' : collapsed;
}

type MessageRow = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  contentPlain: string;
  // S02 (ADR-2 / FR-RC02): rich content 컬럼. S01 additive 컬럼이므로
  // 기존 row 는 NULL — 신규 write 경로(send/update)가 채웁니다. SELECT
  // 경로에서 미선택(undefined)일 수 있어 옵셔널로 둡니다.
  contentRaw?: string | null;
  contentAst?: Prisma.JsonValue;
  // S04 (ADR-2 / FR-MSG-19): 메시지 타입. SELECT 미선택 시 undefined →
  // toDto 가 DEFAULT 로 폴백합니다(forward-compat).
  type?: MessageType | null;
  mentions: Prisma.JsonValue;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  idempotencyKey: string | null;
  // task-014-B: null for root messages; set for replies.
  parentMessageId: string | null;
  // task-044-iter2: pinned message marker. null when 미고정.
  pinnedAt?: Date | null;
  pinnedBy?: string | null;
  // S05 (FR-MSG-06): 낙관적 잠금 버전. SELECT 미선택 시 undefined →
  // toDto 가 0 으로 폴백(forward-compat). 편집마다 +1.
  version?: number | null;
};

// task-044-iter2: Discord-parity cap. Cap 변경 시 shared-types
// MESSAGE_PIN_CAP 도 동일 값으로 갱신해야 합니다.
export const MESSAGE_PIN_CAP = 50;

export type ThreadSummary = {
  replyCount: number;
  lastRepliedAt: string | null;
  recentReplyUserIds: string[];
};

export type ReactionSummary = {
  emoji: string;
  count: number;
  byMe: boolean;
};

export type AttachmentLite = {
  id: string;
  kind: 'IMAGE' | 'VIDEO' | 'FILE';
  mime: string;
  sizeBytes: number;
  originalName: string;
};

export type MessageDto = {
  id: string;
  channelId: string;
  authorId: string;
  content: string | null; // masked when deleted
  // S02 (ADR-2 / FR-RC02): rich content. `content` 와 병행하는 additive
  // 필드 — 신규 렌더러는 contentAst 를 렌더하고 구 클라이언트는 무시합니다.
  // deleted 메시지는 마스킹되어 둘 다 null.
  contentRaw: string | null;
  contentAst: RichTextRoot | null;
  // S04 (ADR-2 / FR-MSG-19): 메시지 타입. SYSTEM_* 는 시스템 행 렌더 +
  // grouped=false + 편집/삭제 UI 숨김의 클라이언트 분기 키.
  type: MessageType;
  mentions: MessageMentions;
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  reactions: ReactionSummary[];
  parentMessageId: string | null;
  thread: ThreadSummary | null;
  attachments: AttachmentLite[];
  // task-044-iter2: pinned message marker. UI 가 행 표시 + 패널 노출
  // 결정에 사용. NULL = 미고정.
  pinnedAt: string | null;
  pinnedBy: string | null;
  // S05 (FR-MSG-06): 낙관적 잠금 버전. 클라이언트가 편집창 오픈 시 스냅샷해
  // PATCH expectedVersion 으로 보냅니다.
  version: number;
};

export type ListDirection = 'before' | 'after' | 'around' | 'initial';

export type ListMessagesArgs = {
  channelId: string;
  before?: string;
  after?: string;
  around?: string;
  limit: number;
  includeDeleted: boolean;
};

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Optional() private readonly metrics?: MetricsService,
    // task-047 iter5 (N3): 자동 follow — root 작성자 + reply 작성자가
    // thread 의 follower 가 되도록 messages.service 가 직접 subscribe 호출.
    // ThreadSubscriptionsService 는 같은 module 내 provider 라 직접 inject.
    @Optional()
    private readonly threadSubscriptions?: ThreadSubscriptionsService,
    // S03 (FR-MSG-05 / FR-RT-04): Redis idempotency 2차 캐시. DB UNIQUE 가
    // 1차 방어선이고, Redis `idem:{userId}:{idempotencyKey}` (TTL 24h) 는
    // read-through 2차 캐시로 재전송 시 DB INSERT 시도 자체를 생략합니다.
    // @Optional 이라 Redis 미주입 단위 테스트는 캐시 없이 DB 경로만 탑니다.
    @Optional()
    @Inject(REDIS)
    private readonly redis?: Redis,
  ) {}

  /** Redis 2차 멱등 캐시 키 (ADR-8 / Redis 전용 상태 카탈로그). */
  private idemCacheKey(userId: string, idempotencyKey: string): string {
    return `idem:${userId}:${idempotencyKey}`;
  }

  toDto(
    row: MessageRow,
    reactions: ReactionSummary[] = [],
    thread: ThreadSummary | null = null,
    attachments: AttachmentLite[] = [],
  ): MessageDto {
    const isDeleted = row.deletedAt !== null;
    // task-047 iter0 (HIGH-046-B): here field default(false) 로 forward-compat.
    const rawMentions = (row.mentions ?? {
      users: [],
      channels: [],
      everyone: false,
      here: false,
    }) as MessageMentions & { here?: boolean };
    const mentions: MessageMentions = {
      users: rawMentions.users,
      channels: rawMentions.channels,
      everyone: rawMentions.everyone,
      here: rawMentions.here ?? false,
    };
    return {
      id: row.id,
      channelId: row.channelId,
      authorId: row.authorId,
      // soft-deleted messages keep their metadata for ordering/audit but the
      // body is masked in the wire format — ADMINs see content via the
      // includeDeleted=true path which returns rows unmasked for moderation.
      content: isDeleted ? null : row.content,
      // S02: rich content 노출. contentRaw 가 NULL 인 legacy row 는 원본
      // `content` 로 폴백해 신규 렌더러도 항상 무언가를 렌더할 수 있게
      // 합니다. contentAst 는 backfill 전 row 에서 NULL 이라 클라이언트가
      // contentRaw 정규식 폴백 렌더를 씁니다.
      contentRaw: isDeleted ? null : (row.contentRaw ?? row.content),
      contentAst: isDeleted ? null : ((row.contentAst as RichTextRoot | null) ?? null),
      // S04: SYSTEM 메시지는 삭제돼도 type 을 유지(삭제 placeholder 분기와
      // 무관). 기존 row(type 미선택/NULL)는 DEFAULT 폴백.
      type: row.type ?? 'DEFAULT',
      mentions,
      edited: row.editedAt !== null,
      deleted: isDeleted,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      reactions,
      parentMessageId: row.parentMessageId,
      thread,
      // Deleted messages drop their attachments too — the wire shape
      // matches the content-masking rule above.
      attachments: isDeleted ? [] : attachments,
      // task-044-iter2: pinned 정보. soft-deleted 메시지는 자동으로 unpinned
      // 되도록 deletedAt 핀 표시를 가립니다.
      pinnedAt: isDeleted ? null : (row.pinnedAt?.toISOString() ?? null),
      pinnedBy: isDeleted ? null : (row.pinnedBy ?? null),
      // S05 (FR-MSG-06): version 노출. SELECT 미선택/legacy row 는 0 폴백.
      version: row.version ?? 0,
    };
  }

  /**
   * Batch-fetch finalized attachments for a set of messages in one
   * round-trip, grouped per messageId. Same one-query-per-page pattern
   * as `aggregateReactions` / `aggregateThreadSummaries`.
   */
  async aggregateAttachments(messageIds: string[]): Promise<Map<string, AttachmentLite[]>> {
    const out = new Map<string, AttachmentLite[]>();
    if (messageIds.length === 0) return out;
    const rows = await this.prisma.attachment.findMany({
      where: { messageId: { in: messageIds }, finalizedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        messageId: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        originalName: true,
      },
    });
    for (const a of rows) {
      if (!a.messageId) continue;
      const lite: AttachmentLite = {
        id: a.id,
        kind: a.kind as 'IMAGE' | 'VIDEO' | 'FILE',
        mime: a.mime,
        sizeBytes: Number(a.sizeBytes),
        originalName: a.originalName,
      };
      const list = out.get(a.messageId) ?? [];
      list.push(lite);
      out.set(a.messageId, list);
    }
    return out;
  }

  /**
   * Task-014-B: aggregate reply counts + last-reply metadata for a set
   * of root messages in one shot. Emits a Map keyed by rootId. Uses the
   * `(parentMessageId, createdAt)` index for the GROUP BY.
   *
   * `recentReplyUserIds` is sourced via a LATERAL subquery so the
   * distinct-user list is trimmed at 3 per root without pulling the
   * entire replies table into memory.
   */
  async aggregateThreadSummaries(rootIds: string[]): Promise<Map<string, ThreadSummary>> {
    const out = new Map<string, ThreadSummary>();
    if (rootIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<
      {
        parentMessageId: string;
        replyCount: bigint;
        lastRepliedAt: Date | null;
        recentReplyUserIds: string[];
      }[]
    >(Prisma.sql`
      SELECT
        m."parentMessageId"                              AS "parentMessageId",
        COUNT(*)::bigint                                 AS "replyCount",
        MAX(m."createdAt")                               AS "lastRepliedAt",
        COALESCE(
          (SELECT ARRAY_AGG(uid ORDER BY last_at DESC)
             FROM (
               SELECT r."authorId" AS uid, MAX(r."createdAt") AS last_at
                 FROM "Message" r
                WHERE r."parentMessageId" = m."parentMessageId"
                  AND r."deletedAt" IS NULL
                GROUP BY r."authorId"
                ORDER BY MAX(r."createdAt") DESC
                LIMIT 3
             ) top
          ),
          ARRAY[]::uuid[]
        ) AS "recentReplyUserIds"
      FROM "Message" m
      WHERE m."parentMessageId" IN (${Prisma.join(rootIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND m."deletedAt" IS NULL
      GROUP BY m."parentMessageId"
    `);
    for (const r of rows) {
      out.set(r.parentMessageId, {
        replyCount: Number(r.replyCount),
        lastRepliedAt: r.lastRepliedAt?.toISOString() ?? null,
        recentReplyUserIds: r.recentReplyUserIds ?? [],
      });
    }
    return out;
  }

  /**
   * Task-013-B: aggregate reactions across many message ids in a single
   * GROUP BY pass. Returns a Map keyed by messageId so the caller can
   * splice results onto each DTO without an N+1. `byMe` piggybacks on
   * the same query via `BOOL_OR("userId" = $viewerId)`.
   */
  async aggregateReactions(
    messageIds: string[],
    viewerId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    const out = new Map<string, ReactionSummary[]>();
    if (messageIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<
      { messageId: string; emoji: string; count: bigint; byMe: boolean }[]
    >(Prisma.sql`
      SELECT "messageId", emoji,
             COUNT(*)::bigint AS count,
             BOOL_OR("userId" = ${viewerId}::uuid) AS "byMe"
        FROM "MessageReaction"
       WHERE "messageId" IN (${Prisma.join(messageIds.map((id) => Prisma.sql`${id}::uuid`))})
       GROUP BY "messageId", emoji
       ORDER BY "messageId", count DESC, emoji ASC
    `);
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      list.push({ emoji: r.emoji, count: Number(r.count), byMe: r.byMe });
      out.set(r.messageId, list);
    }
    return out;
  }

  // ------------------------------------------------------------------ send

  /**
   * Persist a new message. Idempotency semantics (S03 / FR-MSG-05 / ADR-2):
   *   - If `idempotencyKey` is null → always create.
   *   - Scope is `@@unique([authorId, idempotencyKey])` — a USER-scoped key
   *     (channel-independent). User A's key reused by user B yields a NEW row.
   *   - 2-tier dedupe: Redis `idem:{userId}:{key}` (24h) is a read-through
   *     cache that short-circuits the DB INSERT on a retry; the DB PARTIAL
   *     UNIQUE index is the authoritative 1차 defence.
   *   - If a row already exists with the SAME content → return it, mark
   *     `replayed=true` so the controller can set `Idempotency-Replayed` + 200.
   *   - If it exists with DIFFERENT content → 409 IDEMPOTENCY_KEY_REUSE_CONFLICT.
   */
  async send(args: {
    // null for Global DM channels — mention extraction is skipped and
    // outbox payloads carry workspaceId=null so the WS dispatcher
    // routes by channel room only.
    workspaceId: string | null;
    channelId: string;
    authorId: string;
    content: string;
    idempotencyKey: string | null;
    // S03 (FR-MSG-04): clientNonce echoed on the message:created WS event so
    // the sending tab swaps its optimistic row. Distinct from idempotencyKey
    // in ROLE (UI mapping vs server dedupe) even though the client sends the
    // same UUID for both.
    nonce?: string | null;
    parentMessageId?: string | null;
    attachmentIds?: string[];
    // task-044-iter3: sender role (`OWNER` / `ADMIN` / `MEMBER`) used to
    // gate `@everyone` fanout. Optional for back-compat with existing
    // callers (including DM channels where the workspace member concept
    // is N/A) — defaults to MEMBER which downgrades `everyone=true`.
    actorRole?: GateActorRole;
  }): Promise<{ message: MessageRow; replayed: boolean }> {
    // S03 (FR-MSG-05 / FR-RT-04): Redis read-through 2차 캐시. 재전송 시
    // 동일 키가 캐시에 있으면 DB INSERT 시도 자체를 생략하고 캐시된
    // messageId 로 행을 되돌립니다(replayed). 캐시 미스/Redis 장애는
    // 조용히 통과 — DB UNIQUE 가 1차 방어선이라 정합성은 유지됩니다.
    if (args.idempotencyKey && this.redis) {
      const cached = await this.readIdemCache(args.authorId, args.idempotencyKey);
      if (cached) {
        const existing = (await this.prisma.message.findUnique({
          where: { id: cached },
        })) as MessageRow | null;
        if (existing) {
          // S03 review SEC-03 (intentional, documented): the idempotency key is
          // USER-scoped and channel-INDEPENDENT by design (ADR-2 / FR-MSG-05) —
          // the SAME user replaying the SAME key+content into a DIFFERENT
          // channel dedupes to the original row (200 replay). This is the
          // documented behavioural delta vs the old channel-scoped index and is
          // covered by the int spec. Cross-channel message-BODY access is still
          // gated upstream by ChannelAccessGuard before this code runs, so the
          // replay leaks no row the caller couldn't already create; we therefore
          // do NOT 409 on a channel mismatch. Only a CONTENT mismatch (same key,
          // different content) is a client reuse bug → 409.
          if (existing.content !== args.content) {
            throw new DomainError(
              ErrorCode.IDEMPOTENCY_KEY_REUSE_CONFLICT,
              'idempotency key already used with different content',
            );
          }
          this.metrics?.messagesSentIdempotentReplayedTotal.inc();
          return { message: existing, replayed: true };
        }
        // Cache pointed at a vanished row (purge race) → fall through to DB.
      }
    }
    // Validate attachment ownership + channel scope BEFORE the insert
    // transaction so a bad id fails fast without an uncommitted row.
    if (args.attachmentIds && args.attachmentIds.length > 0) {
      const rows = await this.prisma.attachment.findMany({
        where: {
          id: { in: args.attachmentIds },
          channelId: args.channelId,
          uploaderId: args.authorId,
          finalizedAt: { not: null },
          messageId: null,
        },
        select: { id: true },
      });
      if (rows.length !== args.attachmentIds.length) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_NOT_FOUND,
          'one or more attachments are not finalized or already linked',
        );
      }
    }
    // task-014-B: validate reply target BEFORE the insert tx so we don't
    // need to unwind on a bad parent. Single-level depth is enforced
    // here — parent.parentMessageId must be null.
    if (args.parentMessageId) {
      const parent = await this.prisma.message.findFirst({
        where: { id: args.parentMessageId, channelId: args.channelId, deletedAt: null },
        select: { id: true, parentMessageId: true },
      });
      if (!parent) {
        throw new DomainError(
          ErrorCode.MESSAGE_PARENT_NOT_FOUND,
          'parent message not found in this channel',
        );
      }
      if (parent.parentMessageId !== null) {
        throw new DomainError(
          ErrorCode.MESSAGE_THREAD_DEPTH_EXCEEDED,
          'replies to replies are not supported (single-level threads)',
        );
      }
    }
    // S04 (FR-MSG-13): 멘션 정규화 — `@username` → `@{cuid2}`. 워크스페이스
    // 멤버로 핸들을 resolve 한 뒤, 코드 영역을 보존하며 토큰을 치환합니다.
    // 정규화된 본문이 contentRaw/contentAst 의 단일 출처가 되어 mrkdwn 파서의
    // mention_user 노드(S02 carryover MED-3)가 활성화됩니다. 미해결 핸들은
    // literal 로 유지됩니다. `extractMentions` 는 핸들→userId resolve 를 자체
    // 수행하므로 원본(`args.content`)을 그대로 받습니다.
    const handleMap = await resolveMentionHandles(this.prisma, args.workspaceId, args.content);
    const normalizedContent = normalizeMentions(
      args.content,
      (h) => handleMap.get(h.toLowerCase()) ?? null,
    );
    // Mentions resolve against workspace members / channels. Unknown handles
    // are silently dropped — client must never pre-compute this.
    const rawMentions = await extractMentions(this.prisma, args.workspaceId, args.content);
    // task-044-iter3: silently downgrade `@everyone` for non-OWNER/ADMIN.
    // Default `MEMBER` 으로 보수적 처리 — DM 채널 등 actorRole 미정 호출
    // 도 자동으로 거부됩니다.
    const mentions = gateHereMention(
      gateEveryoneMention(rawMentions, args.actorRole ?? 'MEMBER'),
      args.actorRole ?? 'MEMBER',
    );
    // task-013-A3 (task-011-follow-6 closure): cap the mention fan-out.
    // A message `@a @b @c ...` 500 times would emit 500 outbox rows +
    // 500 WS sends in one tx — tangible latency and a DoS vector. 50
    // is generous for any legitimate conversation; overage returns
    // 422 so the client can trim.
    if ((mentions.users?.length ?? 0) > 50) {
      throw new DomainError(
        ErrorCode.MESSAGE_CONTENT_INVALID,
        'message mentions too many users (max 50)',
      );
    }
    // S02 (FR-MSG-01/03/20/23): mrkdwn 송수신 코어. 원본 → AST + plain 으로
    // 파싱·검증(AST 64KB / 깊이 / 노드 한도). 한도 위반은 DomainError
    // (PARSE_* / MESSAGE_TOO_LONG) 로 던져 전역 필터가 400 매핑.
    //
    // NOTE(S02 정확화 — 리뷰 MED#2/#4): contentPlain 은 파서 평문
    // (astToPlain→collapsePlain)을 사용합니다. 이는 기존 normalizeContent
    // 와 *동작 동치가 아닙니다*: 구 normalizeContent 는 `@`/`#` sigil 만
    // 떼고 핸들은 남겼으나(@alice→alice), 신규 평문은 파서가 `@{cuid2}`
    // 토큰만 mention 노드로 인식하므로 라이브 composer 가 보내는 평문
    // `@username` 은 리터럴 텍스트로 sigil 채 유지됩니다. contentPlain 은
    // search_tsv / LEFT(contentPlain,140) 스니펫에 쓰이므로 FTS 토큰·미리보기
    // 가 미세하게 달라질 수 있습니다(의도된 변경 — 단일 출처 통일). 길이
    // 한도(MESSAGE_TOO_LONG)는 contentPlain 기준이나, 컨트롤러 DTO
    // (MessageContentSchema.max(4000))가 raw 를 먼저 캡하고 plain ≤ raw 라
    // 실사용에선 DTO 가 우선 거부합니다(파이프라인 enforce 는 방어선).
    //
    // S04: 정규화된 본문(`@{cuid2}`)을 파싱해 contentRaw/contentAst 의 단일
    // 출처로 삼습니다. 원본 `content`(legacy 컬럼)는 `@username` 표기를
    // 유지하므로 정규식 폴백 렌더러도 깨지지 않습니다.
    //
    // S04 review HIGH (FR-MSG-13): 정규화 시점에 이미 해석한 username/channel
    // name 을 mention 노드의 label 로 박아, 라이브 렌더가 멤버 맵 도착 전에도
    // raw cuid 가 아니라 `@username` 을 표시하게 합니다(회귀 방지).
    const labelMaps = await resolveMentionLabelMaps(this.prisma, args.workspaceId, args.content);
    const processed = processMrkdwn(normalizedContent, {
      mentionLabels: {
        user: (id) => labelMaps.users.get(id),
        channel: (id) => labelMaps.channels.get(id),
      },
    });
    const contentPlain = processed.contentPlain;

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            channelId: args.channelId,
            authorId: args.authorId,
            content: args.content,
            contentPlain,
            // S02 additive 컬럼(S01 nullable 추가분). expand-contract:
            // 기존 `content`/`contentPlain` 병행 유지, 신규 경로가
            // contentRaw/contentAst/contentPlainV2 를 채웁니다(스키마 무변경).
            // `version` 은 미사용(default 0) — 아래 NOTE 참조.
            // S04 (FR-MSG-13): contentRaw 는 정규화된 본문(`@{cuid2}`).
            contentRaw: normalizedContent,
            contentAst: processed.contentAst as unknown as Prisma.InputJsonValue,
            contentPlainV2: contentPlain,
            // NOTE(S02): `version` 은 이 슬라이스에서 쓰지 않습니다 — 스키마
            // default(0) 유지. optimistic-lock 버전 증가는 편집 충돌 처리와
            // 함께 후속 슬라이스로 이관합니다. S00 평탄 스키마가 version 을
            // 요구하나(events.ts 참조) 라이브 와이어는 중첩 페이로드라 미사용.
            mentions: mentions as unknown as Prisma.InputJsonValue,
            idempotencyKey: args.idempotencyKey,
            // S03 (FR-MSG-04): persist clientNonce. Echoed on message:created;
            // also lets a reconnect-resend path observe the prior send.
            nonce: args.nonce ?? null,
            parentMessageId: args.parentMessageId ?? null,
          },
        });
        if (args.attachmentIds && args.attachmentIds.length > 0) {
          // Link the finalized attachments to the message. The pre-tx
          // validation above bounded the set to ids owned by this user
          // + unlinked + same channel, so a raw updateMany is safe.
          await tx.attachment.updateMany({
            where: {
              id: { in: args.attachmentIds },
              messageId: null,
              uploaderId: args.authorId,
              channelId: args.channelId,
            },
            data: { messageId: created.id },
          });
        }
        const payload: MessageCreatedPayload = {
          workspaceId: args.workspaceId,
          channelId: args.channelId,
          actorId: args.authorId,
          // S03 (FR-MSG-04): echo clientNonce so the sending tab swaps its
          // optimistic row. `?? null` keeps the JSON payload stable.
          nonce: args.nonce ?? null,
          message: {
            id: created.id,
            authorId: created.authorId,
            content: created.content,
            // S02 (HIGH-S02-1): carry the rich fields the client cache
            // needs so live messages render via renderAst, not the regex
            // fallback. Mirrors toDto: contentRaw falls back to `content`
            // for parity, contentAst is the just-parsed AST.
            contentRaw: created.contentRaw ?? created.content,
            contentAst: processed.contentAst,
            // S04 (review NIT): carry the canonical message type so the live
            // WS payload satisfies MessageDto at runtime. Without it the
            // dispatcher inserts `type: undefined` into the cache (safe today
            // because isSystemMessageType(undefined) === false, but the typed
            // contract is violated until a REST refetch). Regular sends are
            // always 'DEFAULT'.
            type: created.type,
            mentions,
            createdAt: created.createdAt.toISOString(),
            // task-014-B: extra field is additive — older dispatcher
            // branches that read only {id, authorId, content, …} ignore
            // it. New thread dispatcher branch reads it to route.
            parentMessageId: created.parentMessageId,
          },
        };
        await this.outbox.record(tx, {
          aggregateType: 'Message',
          aggregateId: created.id,
          eventType: MESSAGE_CREATED,
          payload,
        });

        // task-047 iter5 (N3): 자동 follow.
        //  - root 작성 (parentMessageId === null) → 본인이 root 의 follower
        //  - reply 작성 → 본인이 root 의 follower (이미 follower 면 idempotent)
        // ThreadSubscriptionsService.subscribe 가 channel ACL 까지 검증하나
        // 본인 작성 메시지의 채널 access 는 자명 — bypass 안 함, 일관성
        // 위해 동일 path 사용. tx 주입으로 동일 transaction 안에서 처리.
        if (this.threadSubscriptions) {
          const threadRootId = created.parentMessageId ?? created.id;
          await this.threadSubscriptions
            .subscribe({
              userId: args.authorId,
              threadParentId: threadRootId,
              tx: tx as Parameters<ThreadSubscriptionsService['subscribe']>[0]['tx'],
            })
            .catch(() => undefined); // root 작성자가 자기 메시지에 follower 추가 실패는 비-치명
        }

        // Task-011-B: one mention.received outbox event per unique
        // mentioned user. Deduped here (extractMentions can return the
        // same id twice if a user is named multiple times in one
        // message). Author is NEVER notified for self-mentions.
        const snippet = buildSnippet(args.content);
        // task-045 iter6: mute dispatcher gate. 채널 muted user 는
        // mention.received outbox 자체를 스킵 — emit 안 하면 fanout 비용
        // 도 절약. mute 만료 OR 무기한 모두 처리. cleanup job 없음.
        const candidateMentionUserIds = mentions.users.filter(
          (uid) => uid && uid !== args.authorId,
        );
        const dedupedMentionUserIds = Array.from(new Set(candidateMentionUserIds));
        const now = new Date();
        const mutedRows =
          dedupedMentionUserIds.length === 0
            ? []
            : await tx.userChannelMute.findMany({
                where: {
                  channelId: args.channelId,
                  userId: { in: dedupedMentionUserIds },
                  OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
                },
                select: { userId: true },
              });
        const mutedSet = new Set(mutedRows.map((m) => m.userId));
        const mentionedUserIds = new Set<string>();
        for (const uid of dedupedMentionUserIds) {
          if (mutedSet.has(uid)) continue;
          mentionedUserIds.add(uid);
          const mentionPayload: MentionReceivedPayload = {
            targetUserId: uid,
            workspaceId: args.workspaceId,
            channelId: args.channelId,
            messageId: created.id,
            actorId: args.authorId,
            snippet,
            createdAt: created.createdAt.toISOString(),
            everyone: mentions.everyone === true,
            // task-047 iter0 (HIGH-046-B): @here e2e payload.
            here: mentions.here === true,
          };
          await this.outbox.record(tx, {
            aggregateType: 'UserMention',
            aggregateId: uid,
            eventType: MENTION_RECEIVED,
            payload: mentionPayload,
          });
        }

        // task-014-B: emit the aggregate thread event when this is a
        // reply. Fan-out = root author + up to 19 recent repliers, minus
        // anyone who was ALREADY toasted via mention.received for this
        // message. Dispatcher-side dedupe (mention precedes reply) picks
        // the winner when both fire — see dispatcher.ts.
        if (created.parentMessageId) {
          const thread = await this.buildThreadReplyPayload(
            tx,
            created.parentMessageId,
            created.id,
            args.channelId,
            args.workspaceId,
            args.authorId,
            created.createdAt,
            mentionedUserIds,
          );
          if (thread) {
            await this.outbox.record(tx, {
              aggregateType: 'Message',
              aggregateId: created.parentMessageId,
              eventType: MESSAGE_THREAD_REPLIED,
              payload: thread,
            });
          }
        }
        return created as MessageRow;
      });
      this.metrics?.messagesSentTotal.inc();
      // S03: populate the Redis 2차 cache so a retry of THIS key skips the
      // DB INSERT entirely. Best-effort — a Redis failure never fails the send.
      if (args.idempotencyKey) {
        await this.writeIdemCache(args.authorId, args.idempotencyKey, row.id);
      }
      return { message: row, replayed: false };
    } catch (e) {
      // P2002 = unique violation. With the S03 USER-scoped partial index
      // (authorId, idempotencyKey) WHERE idempotencyKey IS NOT NULL, this
      // fires when the same user reuses a key — regardless of channel.
      if (
        args.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // S03 (ADR-2 / FR-MSG-05): lookup is USER-scoped — NOT channel-scoped.
        // The same key is unique per author across all channels, so the
        // existing row is found by (authorId, idempotencyKey) alone.
        const existing = await this.prisma.message.findFirst({
          where: {
            authorId: args.authorId,
            idempotencyKey: args.idempotencyKey,
          },
        });
        if (!existing) throw e; // race: row vanished → surface original error
        // S03 review SEC-03: USER-scoped key is channel-INDEPENDENT by design
        // (see the cache-hit branch above) — a different channel is a valid
        // replay, NOT a conflict. Only a content mismatch is a reuse conflict.
        if (existing.content !== args.content) {
          throw new DomainError(
            ErrorCode.IDEMPOTENCY_KEY_REUSE_CONFLICT,
            'idempotency key already used with different content',
          );
        }
        this.metrics?.messagesSentIdempotentReplayedTotal.inc();
        // Warm the cache so subsequent retries short-circuit before the DB.
        await this.writeIdemCache(args.authorId, args.idempotencyKey, existing.id);
        return { message: existing as MessageRow, replayed: true };
      }
      throw e;
    }
  }

  /**
   * S03 (FR-MSG-05 / FR-RT-04): read the Redis idempotency 2차 cache. Returns
   * the cached messageId or null. Best-effort — a Redis error returns null so
   * the caller falls back to the authoritative DB UNIQUE path.
   */
  private async readIdemCache(userId: string, key: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(this.idemCacheKey(userId, key));
    } catch {
      return null;
    }
  }

  /**
   * Write the Redis idempotency 2차 cache with a 24h TTL (ADR-8 — Redis 전용
   * 상태 카탈로그: `idem:{userId}:{idempotencyKey}` TTL 24h). Best-effort.
   */
  private async writeIdemCache(userId: string, key: string, messageId: string): Promise<void> {
    if (!this.redis) return;
    try {
      // EX 86400 = 24h. The DB UNIQUE index outlives the cache, so a TTL
      // expiry merely means a post-24h retry re-checks the DB (intended —
      // see FR-RT edge case "idempotencyKey 24h 만료 후 재전송").
      await this.redis.set(this.idemCacheKey(userId, key), messageId, 'EX', 86400);
    } catch {
      // swallow — cache miss on the next retry is harmless (DB is canonical).
    }
  }

  /**
   * task-014-B: gather the thread.replied payload inside the send tx so
   * the counts are consistent with the row we just inserted. Returns
   * `null` when the root has been deleted between the pre-check and
   * here (rare, but possible under concurrent soft-delete).
   */
  private async buildThreadReplyPayload(
    tx: Prisma.TransactionClient,
    rootId: string,
    _newReplyId: string,
    channelId: string,
    workspaceId: string | null,
    replierId: string,
    replyCreatedAt: Date,
    excludeRecipients: Set<string>,
  ): Promise<MessageThreadRepliedPayload | null> {
    const root = await tx.message.findUnique({
      where: { id: rootId },
      select: { authorId: true, deletedAt: true },
    });
    if (!root || root.deletedAt) return null;

    // Aggregate replies in the same tx so the count includes the row we
    // just wrote. `ORDER BY createdAt DESC` for the last-N distinct
    // repliers; DISTINCT via a subquery so a single chatter doesn't
    // consume all 20 recipient slots.
    const rows = await tx.$queryRaw<{ total: bigint; lastAt: Date | null }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total, MAX("createdAt") AS "lastAt"
        FROM "Message"
       WHERE "parentMessageId" = ${rootId}::uuid
         AND "deletedAt" IS NULL
    `);
    const replyCount = Number(rows[0]?.total ?? 0n);
    const lastAt = rows[0]?.lastAt ?? replyCreatedAt;

    const recent = await tx.$queryRaw<{ authorId: string }[]>(Prisma.sql`
      SELECT DISTINCT ON ("authorId") "authorId"
        FROM (
          SELECT "authorId", "createdAt"
            FROM "Message"
           WHERE "parentMessageId" = ${rootId}::uuid
             AND "deletedAt" IS NULL
           ORDER BY "createdAt" DESC
           LIMIT 200
        ) latest
       ORDER BY "authorId", "createdAt" DESC
    `);
    // Keep the first 3 for the avatar stack; the outbox payload is
    // small + bounded.
    const recentReplyUserIds = recent.slice(0, 3).map((r) => r.authorId);

    // Recipients: root author first so the dispatcher can check mail
    // priority cheaply, then up to 19 recent repliers, deduped, with
    // author self-filter + already-mentioned filter applied.
    const recipients: string[] = [];
    const seen = new Set<string>();
    const push = (uid: string) => {
      if (!uid || uid === replierId) return;
      if (excludeRecipients.has(uid)) return;
      if (seen.has(uid)) return;
      seen.add(uid);
      recipients.push(uid);
    };
    push(root.authorId);
    for (const { authorId } of recent) {
      if (recipients.length >= THREAD_REPLY_RECIPIENT_CAP) break;
      push(authorId);
    }

    return {
      workspaceId,
      channelId,
      rootMessageId: rootId,
      replierId,
      replyCount,
      lastRepliedAt: lastAt.toISOString(),
      recentReplyUserIds,
      recipients,
    };
  }

  // -------------------------------------------------- S04 system messages

  /**
   * S04 (FR-MSG-19 / FR-RC10) — 시스템 메시지 생성. SYSTEM_* 타입은 항상
   * authorType=SYSTEM, contentRaw 는 서버 생성 템플릿(`renderSystemMessageTemplate`),
   * contentAst 는 그 템플릿을 파싱한 결과입니다. 편집·삭제·멘션 알림 fan-out
   * 은 발생하지 않습니다(독립 행 · grouped=false 강제는 클라이언트가 type 으로
   * 분기). `actorId` 는 ADR-2 의 "시스템 메시지도 bot userId" 규약에 따라 행위
   * 주체(가입/추방/변경 수행자)의 userId 를 authorId 로 저장합니다.
   *
   * 멱등성은 호출측(가입·핀·이름변경 도메인)이 책임집니다 — 시스템 메시지는
   * idempotencyKey 없이 생성됩니다.
   */
  async createSystemMessage(args: {
    workspaceId: string | null;
    channelId: string;
    /** 행위 주체 userId — authorId 로 저장(ADR-2: 시스템 메시지도 userId 필수). */
    actorId: string;
    type: Exclude<MessageType, 'DEFAULT'>;
    /** 템플릿 변수(username / old / new / topic 등). */
    vars: Record<string, string>;
  }): Promise<MessageRow> {
    const contentRaw = renderSystemMessageTemplate(args.type, args.vars);
    const processed = processMrkdwn(contentRaw);
    const emptyMentions: MessageMentions = {
      users: [],
      channels: [],
      everyone: false,
      here: false,
    };
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          channelId: args.channelId,
          authorId: args.actorId,
          authorType: 'SYSTEM',
          type: args.type,
          content: contentRaw,
          contentPlain: processed.contentPlain,
          contentRaw,
          contentAst: processed.contentAst as unknown as Prisma.InputJsonValue,
          contentPlainV2: processed.contentPlain,
          mentions: emptyMentions as unknown as Prisma.InputJsonValue,
        },
      });
      const payload: MessageCreatedPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        nonce: null,
        message: {
          id: created.id,
          authorId: created.authorId,
          content: created.content,
          contentRaw: created.contentRaw ?? created.content,
          contentAst: processed.contentAst,
          // S04: SYSTEM 메시지 타입을 WS 페이로드에 실어 클라이언트 캐시가
          // 시스템 행으로 렌더하도록 합니다(additive — 구 디스패처는 무시).
          type: args.type,
          mentions: emptyMentions,
          createdAt: created.createdAt.toISOString(),
          parentMessageId: created.parentMessageId,
        },
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: created.id,
        eventType: MESSAGE_CREATED,
        payload,
      });
      return created as MessageRow;
    });
  }

  // ------------------------------------------------------------------ list

  async list(args: ListMessagesArgs): Promise<{
    items: MessageRow[];
    hasMore: boolean;
    prevCursor: string | null;
    nextCursor: string | null;
  }> {
    const { channelId, limit, includeDeleted } = args;

    const directions = [args.before, args.after, args.around].filter(Boolean).length;
    if (directions > 1) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'before / after / around are mutually exclusive',
      );
    }

    // -------- around: split into before(limit/2) + after(limit/2) around msgId
    if (args.around) {
      const anchor = await this.prisma.message.findFirst({
        where: { id: args.around, channelId },
        select: { createdAt: true, id: true },
      });
      if (!anchor) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'anchor message not found');
      }
      const half = Math.ceil(limit / 2);
      const beforeItems = await this.rawList({
        channelId,
        direction: 'before',
        cursor: { createdAt: anchor.createdAt.toISOString(), id: anchor.id },
        inclusive: true,
        limit: half + 1,
        includeDeleted,
      });
      const afterItems = await this.rawList({
        channelId,
        direction: 'after',
        cursor: { createdAt: anchor.createdAt.toISOString(), id: anchor.id },
        inclusive: false,
        limit: half,
        includeDeleted,
      });
      // Merge → dedupe anchor → always DESC by (createdAt, id)
      const byId = new Map<string, MessageRow>();
      for (const r of beforeItems) byId.set(r.id, r);
      for (const r of afterItems) byId.set(r.id, r);
      const items = [...byId.values()].sort((a, b) => {
        const d = b.createdAt.getTime() - a.createdAt.getTime();
        return d !== 0 ? d : b.id.localeCompare(a.id);
      });
      return {
        items,
        hasMore: false,
        prevCursor: items.length > 0 ? cursorFor(items[0]) : null,
        nextCursor: items.length > 0 ? cursorFor(items[items.length - 1]) : null,
      };
    }

    // -------- before / after / initial
    const direction: 'before' | 'after' = args.after ? 'after' : 'before';
    const cursor = args.before
      ? decodeCursor(args.before)
      : args.after
        ? decodeCursor(args.after)
        : null;

    // Fetch limit+1 to detect hasMore without another count query.
    const fetched = await this.rawList({
      channelId,
      direction,
      cursor,
      inclusive: false,
      limit: limit + 1,
      includeDeleted,
    });
    const hasMore = fetched.length > limit;
    // BLOCKER fix (S10 review): `fetched` is ALWAYS DESC by (createdAt, id)
    // — `rawList` reverses the ASC `after` rows before returning here. The
    // extra (limit+1)-th row only marks the page boundary and must be trimmed
    // on the side that does NOT abut the NEXT page's cursor:
    //   - before: the next page walks OLDER via nextCursor (= the OLDEST/last
    //     item). The surplus row is the OLDEST (DESC tail) → drop the tail;
    //     `slice(0, limit)` is correct and unchanged.
    //   - after:  gap-fetch walks NEWER and advances by prevCursor (= the
    //     NEWEST/first item). The surplus row is therefore the NEWEST (DESC
    //     head). The old `slice(0, limit)` dropped the OLDEST row — the one
    //     closest to the `after` cursor — so every full page (>limit gap)
    //     permanently lost exactly one message at the boundary. Dropping the
    //     HEAD instead keeps the `limit` rows nearest the cursor, so paging
    //     by prevCursor covers the whole range with zero loss. `before` is
    //     untouched (no regression).
    const items = direction === 'after' && hasMore ? fetched.slice(1) : fetched.slice(0, limit);

    return {
      items,
      hasMore,
      prevCursor: items.length > 0 ? cursorFor(items[0]) : null,
      nextCursor: items.length > 0 ? cursorFor(items[items.length - 1]) : null,
    };
  }

  /**
   * Raw row-value comparison against `(channelId, createdAt, id)` index.
   * Postgres-native `(created_at, id) </> ($t, $id)` keeps the planner on an
   * Index Scan — confirmed by the EXPLAIN script and the `messages.explain`
   * integration test. Never replace with Prisma's builder: the generated
   * OR-of-AND form degrades to a Sort node once the dataset grows.
   */
  private async rawList(args: {
    channelId: string;
    direction: 'before' | 'after';
    // S03: cursor tuple uses the canonical `{ createdAt, id }` shape (FR-MSG-21);
    // decodeCursor normalises legacy `{ t, id }` tokens to this on the way in.
    cursor: { createdAt: string; id: string } | null;
    inclusive: boolean; // true = use <=/>= (used for around-anchor inclusion)
    limit: number;
    includeDeleted: boolean;
  }): Promise<MessageRow[]> {
    const params: unknown[] = [args.channelId, args.limit];
    const deletedFilter = args.includeDeleted ? '' : 'AND "deletedAt" IS NULL';

    // Build the "cursor comparison" fragment. 4 cases × (before/after) × (incl/excl).
    let cursorSql = '';
    let orderSql = '';
    if (args.cursor) {
      params.push(args.cursor.createdAt, args.cursor.id);
      const op =
        args.direction === 'before' ? (args.inclusive ? '<=' : '<') : args.inclusive ? '>=' : '>';
      cursorSql = `AND ("createdAt", id) ${op} ($3::timestamp, $4::uuid)`;
      orderSql = args.direction === 'before' ? 'DESC' : 'ASC';
    } else {
      orderSql = 'DESC'; // initial = newest first
    }

    // task-014-B: channel list is ROOTS ONLY. Replies live behind the
    // thread panel. Partial index `Message_channel_roots_idx` keeps
    // this on an index scan; without the predicate EXPLAIN showed a
    // seq scan once replies outnumbered roots.
    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain",
             "contentRaw", "contentAst", "type", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey", "parentMessageId",
             "pinnedAt", "pinnedBy", "version"
        FROM "Message"
       WHERE "channelId" = $1::uuid
             AND "parentMessageId" IS NULL
             ${deletedFilter}
             ${cursorSql}
       ORDER BY "createdAt" ${orderSql}, id ${orderSql}
       LIMIT $2
    `;
    const rows = await this.prisma.$queryRawUnsafe<MessageRow[]>(sql, ...params);

    // After-direction rows are fetched ASC so we flip them before returning
    // to keep the DTO contract (always createdAt DESC).
    if (args.direction === 'after') rows.reverse();
    return rows;
  }

  // ---------------------------------------------------------- thread replies

  /**
   * task-014-B: paginate replies for a single root. ASC order (oldest
   * first) matches the Slack/Discord side-panel UX. Cursor format is the
   * same opaque base64 as the main list.
   */
  async listThreadReplies(args: {
    channelId: string;
    rootId: string;
    // S03: canonical `{ createdAt, id }` cursor tuple (FR-MSG-21).
    cursor: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<{
    root: MessageRow;
    items: MessageRow[];
    hasMore: boolean;
    nextCursor: { createdAt: Date; id: string } | null;
    prevCursor: { createdAt: Date; id: string } | null;
  }> {
    const root = (await this.prisma.message.findFirst({
      where: { id: args.rootId, channelId: args.channelId, deletedAt: null },
    })) as MessageRow | null;
    if (!root) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    if (root.parentMessageId !== null) {
      // Replies cannot themselves host threads — catches a client that
      // opened a thread panel on a reply id.
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'id is not a thread root');
    }

    const params: unknown[] = [args.rootId, args.limit + 1];
    let cursorSql = '';
    if (args.cursor) {
      params.push(args.cursor.createdAt, args.cursor.id);
      cursorSql = `AND ("createdAt", id) > ($3::timestamp, $4::uuid)`;
    }
    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain",
             "contentRaw", "contentAst", "type", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey", "parentMessageId",
             "pinnedAt", "pinnedBy", "version"
        FROM "Message"
       WHERE "parentMessageId" = $1::uuid
             AND "deletedAt" IS NULL
             ${cursorSql}
       ORDER BY "createdAt" ASC, id ASC
       LIMIT $2
    `;
    const fetched = await this.prisma.$queryRawUnsafe<MessageRow[]>(sql, ...params);
    const hasMore = fetched.length > args.limit;
    const items = fetched.slice(0, args.limit);
    return {
      root,
      items,
      hasMore,
      // Always produce both cursors so the client can jump either way.
      // The main list uses opaque strings, we return structured shapes
      // here so the controller can encode via `cursorFor`.
      prevCursor: items.length > 0 ? { createdAt: items[0].createdAt, id: items[0].id } : null,
      nextCursor:
        items.length > 0
          ? { createdAt: items[items.length - 1].createdAt, id: items[items.length - 1].id }
          : null,
    };
  }

  // ------------------------------------------------------------------ get

  async getOne(args: {
    channelId: string;
    msgId: string;
    includeDeleted?: boolean;
  }): Promise<MessageRow | null> {
    const row = await this.prisma.message.findFirst({
      where: {
        id: args.msgId,
        channelId: args.channelId,
        ...(args.includeDeleted ? {} : { deletedAt: null }),
      },
    });
    return (row as MessageRow | null) ?? null;
  }

  async requireOne(args: {
    channelId: string;
    msgId: string;
    includeDeleted?: boolean;
  }): Promise<MessageRow> {
    const row = await this.getOne(args);
    if (!row) throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    return row;
  }

  // ------------------------------------------------------------------ update

  async update(args: {
    workspaceId: string | null;
    channelId: string;
    msgId: string;
    actorId: string;
    content: string;
    // S05 (FR-MSG-06): 낙관적 잠금 기대 version. 클라이언트가 편집창 오픈
    // 시 스냅샷한 MessageDto.version. 현재 row.version 과 불일치하면 409
    // (MESSAGE_VERSION_CONFLICT) + 현재 MessageDto 를 details.current 로 반환.
    expectedVersion: number;
    // task-044-iter3: edit 도중 사용자가 `@everyone` 추가하면 send 와
    // 동일하게 권한 체크. 미지정 시 MEMBER 로 보수 처리.
    actorRole?: GateActorRole;
  }): Promise<MessageRow> {
    const rawMentions = await extractMentions(this.prisma, args.workspaceId, args.content);
    const mentions = gateHereMention(
      gateEveryoneMention(rawMentions, args.actorRole ?? 'MEMBER'),
      args.actorRole ?? 'MEMBER',
    );
    // S04 (FR-MSG-13): 편집 본문도 멘션 정규화 적용 — `@username` → `@{cuid2}`.
    const handleMap = await resolveMentionHandles(this.prisma, args.workspaceId, args.content);
    const normalizedContent = normalizeMentions(
      args.content,
      (h) => handleMap.get(h.toLowerCase()) ?? null,
    );
    // S02: 편집 본문도 동일 파이프라인으로 파싱·검증. 한도 위반 시
    // DomainError(400) — 편집 트랜잭션 진입 전에 거부됩니다.
    // S04 review HIGH (FR-MSG-13): 편집 본문도 멘션 label 을 박습니다.
    const labelMaps = await resolveMentionLabelMaps(this.prisma, args.workspaceId, args.content);
    const processed = processMrkdwn(normalizedContent, {
      mentionLabels: {
        user: (id) => labelMaps.users.get(id),
        channel: (id) => labelMaps.channels.get(id),
      },
    });
    const contentPlain = processed.contentPlain;
    const editedAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      // S05 (FR-MSG-06) 1단계: 편집 전 현재 row 스냅샷. version 검증 + 이력
      // 적재의 원자성을 위해 트랜잭션 안에서 먼저 읽는다. deletedAt 무관하게
      // 읽되, soft-deleted 면 아래 낙관적 UPDATE 가 count=0 으로 거른다.
      const before = await tx.message.findFirst({
        where: { id: args.msgId, channelId: args.channelId },
        select: {
          version: true,
          contentRaw: true,
          contentAst: true,
          contentPlainV2: true,
          contentPlain: true,
          deletedAt: true,
        },
      });

      // S05 (FR-MSG-06) 2단계: 낙관적 UPDATE. version=version+1 + WHERE 절에
      // version=expectedVersion AND deletedAt IS NULL 을 박아 동시 편집을
      // 직렬화한다. `updateMany` 가 count=0 이면 행 부재 / soft-deleted /
      // version 불일치 셋 중 하나 — 위 `before` 로 케이스를 가른다.
      const { count } = await tx.message.updateMany({
        where: {
          id: args.msgId,
          channelId: args.channelId,
          deletedAt: null,
          version: args.expectedVersion,
        },
        data: {
          content: args.content,
          contentPlain,
          // S04 (FR-MSG-13): contentRaw 는 정규화된 본문(`@{cuid2}`).
          contentRaw: normalizedContent,
          contentAst: processed.contentAst as unknown as Prisma.InputJsonValue,
          contentPlainV2: contentPlain,
          mentions: mentions as unknown as Prisma.InputJsonValue,
          editedAt,
          // 낙관적 잠금 bump. updatedAt 은 @updatedAt 으로 자동 갱신.
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        // 행 부재 또는 soft-deleted → NOT_FOUND.
        if (!before || before.deletedAt !== null) {
          throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found or deleted');
        }
        // 행은 살아있으나 version 불일치 → 409 + 현재 MessageDto(details.current).
        // 다른 곳에서 이미 편집되어 클라이언트 스냅샷이 stale 한 경우.
        // security HIGH-02: channelId 를 함께 걸어 교차 채널/워크스페이스
        // 메시지가 details.current 로 새지 않도록 서비스 레이어에서도 격리한다.
        const current = (await tx.message.findFirst({
          where: { id: args.msgId, channelId: args.channelId },
        })) as MessageRow | null;
        // reviewer LOW-1: 회수 사이에 행이 사라졌다면(희박) 409 가 아니라
        // NOT_FOUND 가 의미상 정확하다 — 클라이언트가 stale 편집창을 닫게 한다.
        if (!current) {
          throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found or deleted');
        }
        throw new DomainError(
          ErrorCode.MESSAGE_VERSION_CONFLICT,
          'message was edited elsewhere — reload and retry',
          { current: this.toDto(current) },
        );
      }

      // S05 (FR-MSG-06) 3단계: 편집 전 스냅샷을 EditHistory 에 적재. version 은
      // 편집 전 값(before.version). before 는 count>0 이므로 항상 non-null.
      await tx.messageEditHistory.create({
        data: {
          messageId: args.msgId,
          version: before!.version,
          contentRaw: before!.contentRaw,
          contentAst: (before!.contentAst ?? Prisma.DbNull) as Prisma.InputJsonValue,
          // contentPlain 스냅샷: 신규 슬롯(contentPlainV2) 우선, 없으면 legacy.
          contentPlain: before!.contentPlainV2 ?? before!.contentPlain,
          editedAt,
        },
      });

      // S05 (FR-MSG-06) 4단계: ring buffer cap(10) enforce. 11번째 편집이면
      // 가장 오래된 version 1개를 DELETE 한다. version asc 로 oldest 식별.
      const historyCount = await tx.messageEditHistory.count({
        where: { messageId: args.msgId },
      });
      if (historyCount > EDIT_HISTORY_CAP) {
        const oldest = await tx.messageEditHistory.findMany({
          where: { messageId: args.msgId },
          orderBy: { version: 'asc' },
          take: historyCount - EDIT_HISTORY_CAP,
          select: { id: true },
        });
        await tx.messageEditHistory.deleteMany({
          where: { id: { in: oldest.map((h) => h.id) } },
        });
      }

      const updated = (await tx.message.findUnique({ where: { id: args.msgId } }))!;
      const payload: MessageUpdatedPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        message: {
          id: updated.id,
          authorId: updated.authorId,
          content: updated.content,
          // S02 (HIGH-S02-1): carry the re-parsed rich fields so a live
          // edit updates the cached MessageDto with the new AST instead of
          // dropping to the regex fallback. Mirrors toDto's contentRaw
          // fallback; contentAst is the AST from this edit's parse.
          contentRaw: updated.contentRaw ?? updated.content,
          contentAst: processed.contentAst,
          mentions,
          editedAt: editedAt.toISOString(),
          // S05 verify (FR-MSG-07): 편집 성공 → edited=true 를 실어 라이브 수신측
          // 캐시(edited:false)가 (수정됨) 뱃지를 즉시 표시하게 한다.
          edited: true,
          // S05 (FR-MSG-06): events 계약(MessageUpdatedPayloadSchema)이 요구하는
          // version. 편집 후 새 version 을 실어 라이브 수신측 캐시가 낙관적
          // 잠금 기준을 갱신하게 한다.
          version: updated.version,
        },
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_UPDATED,
        payload,
      });
      return updated as MessageRow;
    });
  }

  // ----------------------------------------------- S05 edit history (FR-RC16)

  /**
   * S05 (FR-RC16): 메시지 편집 이력 조회. 권한(작성자 본인 또는
   * MANAGE_MESSAGES 권한자)은 controller 에서 게이트하므로 service 는 단순
   * 조회만 수행합니다. version desc(최신 편집 먼저), 최대 EDIT_HISTORY_CAP 개.
   */
  async listEditHistory(args: { channelId: string; msgId: string }): Promise<EditHistoryDto[]> {
    // 메시지 존재 확인(deletedAt 무관 — 삭제된 메시지의 이력도 모더레이터가
    // 조회 가능). 부재 시 404.
    const exists = await this.prisma.message.findFirst({
      where: { id: args.msgId, channelId: args.channelId },
      select: { id: true },
    });
    if (!exists) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    }
    const rows = await this.prisma.messageEditHistory.findMany({
      where: { messageId: args.msgId },
      orderBy: { version: 'desc' },
      take: EDIT_HISTORY_CAP,
    });
    return rows.map((r) => ({
      version: r.version,
      contentRaw: r.contentRaw,
      contentAst: (r.contentAst as EditHistoryDto['contentAst']) ?? null,
      contentPlain: r.contentPlain,
      editedAt: r.editedAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------ delete

  async softDelete(args: {
    workspaceId: string | null;
    channelId: string;
    msgId: string;
    actorId: string;
  }): Promise<void> {
    const deletedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      // S05 verify (HIGH): 편집 경로(update)와 동일하게 updateMany +
      // WHERE { id, channelId, deletedAt: null } 로 채널 격리 + 데이터 레이어
      // idempotency 를 강제한다. 컨트롤러의 `if (row.deletedAt) return` 선검사는
      // 트랜잭션 밖 findFirst 라 TOCTOU — 동시/재시도 삭제가 둘 다 통과하면
      // 직전 update() 가 deletedAt 을 더 늦은 시각으로 덮고 두 번째 MESSAGE_DELETED
      // 가 중복 fanout 됐다. count===0(부재/타채널/이미 삭제)이면 no-op 으로
      // 막는다. 또 updateMany 는 행 부재 시 P2025 를 던지지 않는다(update 와 차이).
      const { count } = await tx.message.updateMany({
        where: { id: args.msgId, channelId: args.channelId, deletedAt: null },
        data: { deletedAt },
      });
      if (count === 0) return;
      // count>0 → 같은 tx 안에서 방금 확정된 행이라 항상 존재. payload 용 authorId 만.
      const updated = await tx.message.findUniqueOrThrow({
        where: { id: args.msgId },
        select: { id: true, authorId: true },
      });
      const payload: MessageDeletedPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        message: {
          id: updated.id,
          authorId: updated.authorId,
          deletedAt: deletedAt.toISOString(),
        },
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_DELETED,
        payload,
      });
    });
  }

  // ----------------------------------------------- task-044-iter2 pinning

  /**
   * task-044-iter2: 메시지 pin. 권한 체크는 controller 의 OWNER/ADMIN
   * 가드에서 수행합니다 — service 는 cap (50) 만 enforce 합니다.
   * 이미 pinned 된 메시지를 다시 pin 하면 idempotent (기존 pinnedAt 유지).
   * Soft-deleted 메시지는 pin 불가 (toDto 에서도 마스킹).
   */
  async pin(args: {
    workspaceId: string | null;
    channelId: string;
    msgId: string;
    actorId: string;
  }): Promise<MessageRow> {
    return this.prisma.$transaction(async (tx) => {
      // task-045 iter1 (H1 fix): advisory lock 으로 채널 단위 직렬화.
      // 044 reviewer 발견 — count + update race window 로 두 admin 이
      // 동시에 49→둘 다 49 셈 → cap+1 (51) 가능했음. xact_lock 은 tx
      // commit/rollback 시 자동 해제, 별도 cleanup 불필요.
      // hashtextextended 는 PostgreSQL 12+ 에서 bigint key 안전 생성.
      // prefix `pin:` 으로 다른 advisory lock domain 과 충돌 회피.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pin:${args.channelId}`}, 0))`;

      const target = (await tx.message.findFirst({
        where: { id: args.msgId, channelId: args.channelId, deletedAt: null },
      })) as (MessageRow & { pinnedAt: Date | null }) | null;
      if (!target) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found or deleted');
      }
      if (target.pinnedAt) {
        // idempotent — 같은 row 그대로 반환, outbox 도 다시 emit 안 함.
        return target as MessageRow;
      }
      // cap check: 이 채널의 핀 수가 cap 미만이어야 함. advisory lock 보유
      // 상태에서 count + update 가 직렬화되어 race 가 닫힘.
      const pinned = await tx.message.count({
        where: { channelId: args.channelId, pinnedAt: { not: null }, deletedAt: null },
      });
      if (pinned >= MESSAGE_PIN_CAP) {
        throw new DomainError(
          ErrorCode.MESSAGE_PIN_CAP_EXCEEDED,
          `최대 ${MESSAGE_PIN_CAP}개까지 고정할 수 있습니다`,
        );
      }
      const pinnedAt = new Date();
      const updated = await tx.message.update({
        where: { id: args.msgId },
        data: { pinnedAt, pinnedBy: args.actorId },
      });
      const payload: MessagePinToggledPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        messageId: updated.id,
        pinnedAt: pinnedAt.toISOString(),
        pinnedBy: args.actorId,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_PIN_TOGGLED,
        payload,
      });
      return updated as MessageRow;
    });
  }

  /**
   * task-044-iter2: pin 해제. 미고정 상태에서 unpin 호출은 idempotent
   * (no-op + 같은 row 반환).
   */
  async unpin(args: {
    workspaceId: string | null;
    channelId: string;
    msgId: string;
    actorId: string;
  }): Promise<MessageRow> {
    return this.prisma.$transaction(async (tx) => {
      const target = (await tx.message.findFirst({
        where: { id: args.msgId, channelId: args.channelId },
      })) as (MessageRow & { pinnedAt: Date | null }) | null;
      if (!target) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
      }
      if (!target.pinnedAt) {
        return target as MessageRow;
      }
      const updated = await tx.message.update({
        where: { id: args.msgId },
        data: { pinnedAt: null, pinnedBy: null },
      });
      const payload: MessagePinToggledPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        messageId: updated.id,
        pinnedAt: null,
        pinnedBy: null,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_PIN_TOGGLED,
        payload,
      });
      return updated as MessageRow;
    });
  }

  /**
   * task-044-iter2: 채널의 pinned 메시지 목록. 정렬 pinnedAt DESC,
   * cap 50 까지. soft-deleted 는 자동으로 제외 (deletedAt IS NULL).
   * partial index `Message_channelId_pinnedAt_idx` 가 sparse scan
   * 보장.
   */
  async listPins(channelId: string): Promise<{ items: MessageRow[]; cap: number; used: number }> {
    const items = (await this.prisma.message.findMany({
      where: { channelId, pinnedAt: { not: null }, deletedAt: null },
      orderBy: { pinnedAt: 'desc' },
      take: MESSAGE_PIN_CAP,
    })) as MessageRow[];
    return { items, cap: MESSAGE_PIN_CAP, used: items.length };
  }
}
