import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type AttachmentKind } from '@prisma/client';
import type Redis from 'ioredis';
import {
  MessageMentions,
  type MessageType,
  renderSystemMessageTemplate,
  EDIT_HISTORY_CAP,
  type EditHistoryDto,
  THREAD_BROADCAST_EXCERPT_CAP,
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
import { astHasLink, flagsFromAttachmentKinds } from '../search/message-flags';
import {
  gateChannelMention,
  gateEveryoneMention,
  gateHereMention,
  type GateActorRole,
} from './mentions/gate';
import { ThreadSubscriptionsService } from './thread-subscriptions.service';
import { UnreadService } from '../channels/unread.service';
import {
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_PIN_TOGGLED,
  MESSAGE_THREAD_BROADCAST,
  MESSAGE_THREAD_LOCK_CHANGED,
  MESSAGE_THREAD_REPLIED,
  MESSAGE_UPDATED,
  THREAD_REPLY_RECIPIENT_CAP,
  type MessageCreatedPayload,
  type MessageDeletedPayload,
  type MessagePinToggledPayload,
  type MessageThreadBroadcastPayload,
  type MessageThreadLockChangedPayload,
  type MessageThreadRepliedPayload,
  type MessageUpdatedPayload,
} from './events/message-events';
import { MENTION_RECEIVED, type MentionReceivedPayload } from './events/mention-events';
import { isDndSuppressed } from '../notifications/dnd-gate';
import type { DndSchedule } from '../me/dnd-schedule.service';

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

/**
 * S35 (FR-TH-06): broadcast 메시지의 루트 excerpt. 루트 본문을 공백 collapse 한
 * 뒤 THREAD_BROADCAST_EXCERPT_CAP(50)자로 자르고 초과 시 (cap-1)자 + "…" 로
 * 만든다. PRD "루트 메시지 excerpt(50자, 초과 시 …)". null/빈 본문(삭제 루트
 * 등)은 빈 문자열을 돌려준다.
 */
export function buildThreadBroadcastExcerpt(content: string | null | undefined): string {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= THREAD_BROADCAST_EXCERPT_CAP) return collapsed;
  return collapsed.slice(0, THREAD_BROADCAST_EXCERPT_CAP - 1) + '…';
}

type MessageRow = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  contentPlain: string;
  // S37 (FR-MSG-17): 평문 정본의 신규 슬롯(expand-contract). send/update 가
  // contentPlainV2 를 채우며, legacy `contentPlain` 은 backfill 전 row 의
  // 폴백입니다. SELECT 경로에서 미선택일 수 있어 옵셔널로 둡니다 — toDto 가
  // `contentPlainV2 ?? contentPlain` 순으로 와이어 평문을 정합니다.
  contentPlainV2?: string | null;
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
  // S35 (FR-TH-06): 스레드→채널 broadcast 표식. SELECT 미선택 시 undefined →
  // toDto 가 false 폴백(forward-compat). broadcast 행은 채널 타임라인에
  // 노출되는 SYSTEM_THREAD_BROADCAST 답글 복제본이다.
  isBroadcast?: boolean | null;
  // S38 (FR-TH-13): 스레드 잠금 표식(루트 전용). SELECT 미선택 시 undefined →
  // toDto 가 false 폴백(forward-compat). 스레드 패널 헤더/composer 가 소비한다.
  threadLocked?: boolean | null;
};

// task-044-iter2: Discord-parity cap. Cap 변경 시 shared-types
// MESSAGE_PIN_CAP 도 동일 값으로 갱신해야 합니다.
export const MESSAGE_PIN_CAP = 50;

// S33 (FR-TH-16 / FR-TH-03): threadMeta.replyParticipants(=recentReplyUserIds)
// 의 상한. PRD FR-TH-16/03 은 "최초 답글자 최대 5명"을 명시한다. 이 값을
// 바꾸면 shared-types ThreadSummarySchema 의 `.max(N)` 도 동일하게 갱신해야 한다.
export const THREAD_REPLY_PARTICIPANT_CAP = 5;

// S17 (FR-DM-18): 그룹 DM 에서 차단한 사용자의 메시지 본문 placeholder.
// 삭제가 아니라 자리를 유지한 채 본문만 치환한다(UX). 한국어 존댓말 표기.
export const BLOCKED_MESSAGE_PLACEHOLDER = '[차단된 사용자의 메시지]';

export type ThreadSummary = {
  replyCount: number;
  lastRepliedAt: string | null;
  recentReplyUserIds: string[];
  // S36 (FR-TH-04): per-viewer 스레드 미읽 여부. aggregateThreadSummaries 가
  // viewerId 와 함께 호출되면 산정하고, 그 외(WS dispatcher 합성)는 false.
  hasUnread: boolean;
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
  // S37 (FR-MSG-17): 평문 정본. "메시지 복사" 가 마크다운 대신 사람이 읽는
  // 평문을 복사하도록 노출합니다. deleted 메시지는 content 와 동일 정책으로 null.
  contentPlain: string | null;
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
  // S35 (FR-TH-06): 스레드→채널 broadcast 표식 + 루트 excerpt(50자). broadcast
  // 행만 isBroadcast=true 이며 parentExcerpt 가 채워진다(채널 목록 read-path 가
  // 루트를 batch 조회해 산정). 일반/삭제 메시지는 false/null.
  isBroadcast: boolean;
  parentExcerpt: string | null;
  // S38 (FR-TH-13): 스레드 잠금 표식(루트 전용). 답글은 항상 false.
  threadLocked: boolean;
};

export type ListDirection = 'before' | 'after' | 'around' | 'initial';

export type ListMessagesArgs = {
  channelId: string;
  before?: string;
  after?: string;
  around?: string;
  limit: number;
  includeDeleted: boolean;
  // S17 (FR-DM-17 / FR-TH-19): DM 가시성 하한선. 요청자의 DM 멤버십
  // (ChannelPermissionOverride USER row) visibleFrom 을 그대로 전달한다.
  // null/undefined = 필터 없음(비-DIRECT 채널·legacy DM row). 설정 시 모든
  // 경로(before/after/around/initial)에서 `createdAt >= visibleFrom` 으로
  // 그 시각 이전 메시지를 제외한다 — around 의 contextBefore 도 동일(FR-TH-19).
  visibleFrom?: Date | null;
};

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

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
    // S36 (FR-TH-14, 옵션 A 동기 직접): broadcast 행 soft-delete 시 채널 unread
    // Redis 캐시를 동기 무효화한다. MessagesModule 이 이미 forwardRef(ChannelsModule)
    // 로 UnreadService 를 import 하므로 순환은 모듈 레벨에서 끊겨 있고, 여기선
    // forwardRef + @Optional 로 안전하게 주입한다(미주입 단위테스트는 캐시 무효화
    // 생략 — DB 경로만).
    @Optional()
    @Inject(forwardRef(() => UnreadService))
    private readonly unread?: UnreadService,
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
    // S35 (FR-TH-06): broadcast 행에만 채워지는 루트 메시지 excerpt(50자). 채널
    // 목록 read-path 가 broadcast 행의 parentMessageId 로 루트를 batch 조회해
    // 넘긴다(N+1 없음). 일반 메시지·삭제 메시지는 null.
    parentExcerpt: string | null = null,
  ): MessageDto {
    const isDeleted = row.deletedAt !== null;
    // task-047 iter0 (HIGH-046-B): here field default(false) 로 forward-compat.
    const rawMentions = (row.mentions ?? {
      users: [],
      channels: [],
      everyone: false,
      here: false,
      channel: false,
    }) as MessageMentions & { here?: boolean; channel?: boolean };
    // S33 fix-forward (보안 BLOCKER): 삭제된 메시지는 본문/첨부와 마찬가지로
    // mentions 도 빈 값으로 마스킹합니다. S33 이 답글 보유 deleted thread-root
    // 와 deleted 답글을 채널 목록·스레드 패널에 placeholder 로 새로 노출시키면서,
    // 종전엔 toDto 가 content 만 가리고 mentions 원본을 그대로 실어 보내
    // 삭제 메시지의 @멘션 대상 userId(mentions.users) 가 와이어로 누출됐습니다.
    // content-masking 규칙과 동일하게 비노출 처리합니다 — maskBlockedAuthors 의
    // 빈 mentions 형태와 일관(실제 MessageMentionsSchema 형태).
    const mentions: MessageMentions = isDeleted
      ? { users: [], channels: [], everyone: false, here: false, channel: false }
      : {
          users: rawMentions.users,
          channels: rawMentions.channels,
          everyone: rawMentions.everyone,
          here: rawMentions.here ?? false,
          // S21 fix-forward (MAJOR-D): `@channel` 범위 멘션을 와이어로 전달해야
          // live dispatcher 의 isMention 이 @channel 을 인식한다. 누락(legacy row)은
          // false 폴백.
          channel: rawMentions.channel ?? false,
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
      // S37 (FR-MSG-17): 평문 정본. 신규 슬롯(contentPlainV2) 우선, 없으면 legacy
      // contentPlain 폴백, 그래도 없으면 null. deleted 메시지는 content/contentRaw
      // 마스킹과 동일 정책으로 null 로 가린다(편집 전 평문 누출 방지).
      contentPlain: isDeleted ? null : (row.contentPlainV2 ?? row.contentPlain ?? null),
      // S04: SYSTEM 메시지는 삭제돼도 type 을 유지(삭제 placeholder 분기와
      // 무관). 기존 row(type 미선택/NULL)는 DEFAULT 폴백.
      type: row.type ?? 'DEFAULT',
      mentions,
      // S33 fix-forward (보안 BLOCKER): 삭제된 메시지는 편집 여부/시각도
      // 마스킹합니다. 삭제 전 편집 이력(edited=true / editedAt 시각)이 placeholder
      // 행에 그대로 실리면 삭제된 본문이 한 번 이상 편집됐다는 메타데이터가
      // 누출되므로, content 마스킹과 동일하게 edited=false / editedAt=null 로
      // 가립니다.
      edited: isDeleted ? false : row.editedAt !== null,
      deleted: isDeleted,
      createdAt: row.createdAt.toISOString(),
      editedAt: isDeleted ? null : (row.editedAt?.toISOString() ?? null),
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
      // S35 (FR-TH-06): broadcast 표식 + 루트 excerpt. broadcast 행이 삭제되면
      // (deleted) 본문 마스킹과 일관되게 excerpt 도 가린다. isBroadcast 자체는
      // 행의 정체(채널 타임라인 분기)라 deleted 와 무관하게 유지한다 — 삭제된
      // broadcast 도 placeholder 로 채널에 남되 excerpt 만 비운다.
      isBroadcast: row.isBroadcast ?? false,
      parentExcerpt: isDeleted ? null : (parentExcerpt ?? null),
      // S38 (FR-TH-13): 스레드 잠금 표식(루트 전용). SELECT 미선택/legacy 는 false.
      threadLocked: row.threadLocked ?? false,
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
   * S35 (FR-TH-06): 채널 목록 페이지 내 broadcast 행들의 루트 excerpt 를 한 번에
   * 모은다. broadcast 행은 parentMessageId 로 스레드 루트를 가리키므로, 그
   * parentMessageId 집합의 루트 본문(content)을 단일 IN 쿼리로 읽어 excerpt 로
   * 가공한다(루트당 1회 — N+1 아님). 반환 Map 은 broadcast 행의 id → excerpt.
   * broadcast 행이 없으면 빈 Map(추가 쿼리 없음).
   *
   * 삭제된 루트는 본문이 비어 excerpt 가 빈 문자열이 된다(placeholder 루트의
   * broadcast 는 레이블만 표시) — toDto 의 broadcast deleted 마스킹과 별개다.
   */
  async aggregateBroadcastExcerpts(rows: MessageRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // broadcast 행만 추린다(parentMessageId 보유 + isBroadcast).
    const broadcastRows = rows.filter((r) => r.isBroadcast === true && r.parentMessageId);
    if (broadcastRows.length === 0) return out;
    const rootIds = Array.from(
      new Set(broadcastRows.map((r) => r.parentMessageId).filter((id): id is string => !!id)),
    );
    // S35 fix-forward (보안 F-01/F-03): 루트 조회를 broadcast 행들의 channelId
    // 집합으로 스코프한다(cross-channel excerpt 누출 방어). broadcast 행은
    // 같은 채널 send tx 안에서 parentMessageId = 루트로 생성되므로 정상적으로는
    // 루트와 동일 채널이지만, DB-레벨 불변식(루트·broadcast 동일 channelId)이
    // 부재하므로 read-path 에서 강제한다. WHERE 에 `channelId IN (broadcast 행
    // channelId 들)` 을 더하면, 조작/버그로 다른 채널의 루트를 가리키는 broadcast
    // 행이 있어도 그 루트 본문은 조회되지 않아 excerpt 가 빈 값이 된다. 추가로
    // 아래 루프에서 broadcast 행과 루트의 channelId 일치를 1:1 로 재확인한다.
    const broadcastChannelIds = Array.from(new Set(broadcastRows.map((r) => r.channelId)));
    const roots = await this.prisma.message.findMany({
      where: { id: { in: rootIds }, channelId: { in: broadcastChannelIds } },
      select: { id: true, channelId: true, content: true, deletedAt: true },
    });
    const rootById = new Map(roots.map((root) => [root.id, root]));
    for (const r of broadcastRows) {
      if (!r.parentMessageId) continue;
      const root = rootById.get(r.parentMessageId);
      // 루트가 없거나(타채널로 필터됨) broadcast 행과 채널이 어긋나면 누출
      // 방어로 빈 excerpt 를 돌린다(레이블만). 삭제된 루트도 빈 excerpt.
      if (!root || root.channelId !== r.channelId || root.deletedAt) {
        out.set(r.id, '');
        continue;
      }
      out.set(r.id, buildThreadBroadcastExcerpt(root.content));
    }
    return out;
  }

  /**
   * S33 (FR-TH-16): 루트 메시지 집합의 threadMeta 를 한 번에 모은다. Map 은
   * rootId 로 키잉되며, 답글이 있는(replyCount > 0) 루트만 항목을 담는다 —
   * 답글 0개 루트는 호출측에서 `thread = null` 로 폴백한다(기존 task-014-B 의
   * zero-reply→null 계약 유지).
   *
   * 비정규화 전환(FR-TH-16): replyCount / latestReplyAt 는 더 이상 답글 테이블을
   * GROUP BY 집계하지 않고 루트 행의 S33 비정규화 컬럼을 **직접** 읽는다. 이
   * 값들은 send/soft-delete 의 단일 $transaction 이 원자적으로 유지한다.
   *
   * replyParticipants(≤5 최근 distinct author)는 단순 카운터가 아니므로 루트
   * 행에 비정규화할 수 없다 — 루트 1쿼리 안의 bounded LATERAL 서브쿼리로
   * 채운다(루트당 최대 5 fan-out, N+1 아님). `(parentMessageId, createdAt)`
   * 인덱스로 각 LATERAL 이 인덱스 스캔을 탄다.
   *
   * 반환 ThreadSummary 의 `recentReplyUserIds` 가 곧 PRD 의 replyParticipants 다
   * (와이어 필드명은 기존 클라이언트/디스패처/테스트 호환을 위해 유지).
   *
   * S36 (FR-TH-04 / FR-RS-12): `viewerId` 를 받으면 같은 쿼리에 viewer 의
   * ThreadReadState 를 **배치 조인**해 per-viewer 미읽 여부(`hasUnread`)를 함께
   * 산정한다(루트 집합 단일 쿼리 — N+1 없음). reply bar(qf-thread-chip)의 unread
   * dot 이 이 값을 본다. viewerId 가 없으면(WS dispatcher 합성 등) hasUnread=false
   * 폴백. 미읽 판정은 ThreadReadStateService 와 동일 공식(isBroadcast=false·
   * deletedAt IS NULL·(createdAt,id) 튜플 비교; ThreadReadState 없으면 전체 미읽).
   */
  async aggregateThreadSummaries(
    rootIds: string[],
    viewerId?: string,
  ): Promise<Map<string, ThreadSummary>> {
    const out = new Map<string, ThreadSummary>();
    if (rootIds.length === 0) return out;
    // viewerId 가 있을 때만 ThreadReadState 조인 + 미읽 EXISTS 를 합성한다. 없으면
    // false 리터럴을 산입해 기존 호출 동작(미읽 비계산)을 그대로 유지한다.
    const hasUnreadSql = viewerId
      ? Prisma.sql`EXISTS (
          SELECT 1
            FROM "Message" reply
            LEFT JOIN "ThreadReadState" rs
              ON rs."userId" = ${viewerId}::uuid
             AND rs."parentMessageId" = root.id
           WHERE reply."parentMessageId" = root.id
             AND reply."isBroadcast" = false
             AND reply."deletedAt" IS NULL
             AND (
               rs."lastReadMessageCreatedAt" IS NULL
               OR (reply."createdAt", reply.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
             )
        )`
      : Prisma.sql`false`;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        replyCount: number;
        latestReplyAt: Date | null;
        recentReplyUserIds: string[];
        hasUnread: boolean;
      }[]
    >(Prisma.sql`
      SELECT
        root.id                                          AS "id",
        root."replyCount"                                AS "replyCount",
        root."latestReplyAt"                             AS "latestReplyAt",
        COALESCE(parts.ids, ARRAY[]::uuid[])             AS "recentReplyUserIds",
        ${hasUnreadSql}                                  AS "hasUnread"
      FROM "Message" root
      LEFT JOIN LATERAL (
        -- 루트당 최대 ${THREAD_REPLY_PARTICIPANT_CAP}명: 최근 답글 순으로 distinct author.
        SELECT ARRAY_AGG(uid ORDER BY last_at DESC) AS ids
          FROM (
            SELECT r."authorId" AS uid, MAX(r."createdAt") AS last_at
              FROM "Message" r
             WHERE r."parentMessageId" = root.id
               AND r."deletedAt" IS NULL
               -- S35 fix-forward: broadcast 행은 답글이 아니므로 replyParticipants
               -- (아바타 스택) 집계에서 제외한다. 포함되면 'Also send to #channel'
               -- 작성자가 phantom 참여자로 중복 노출된다.
               AND r."isBroadcast" = false
             GROUP BY r."authorId"
             ORDER BY MAX(r."createdAt") DESC
             LIMIT ${THREAD_REPLY_PARTICIPANT_CAP}
          ) top
      ) parts ON TRUE
      WHERE root.id IN (${Prisma.join(rootIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND root."replyCount" > 0
    `);
    for (const r of rows) {
      out.set(r.id, {
        replyCount: Number(r.replyCount),
        // 컬럼↔와이어 매핑(S33 fix-forward 문서 갭): DB 컬럼 `Message.latestReplyAt`
        // (timestamptz) → ThreadSummary 와이어 필드 `lastRepliedAt`(ISO 문자열).
        // shared-types ThreadSummarySchema 주석과 짝을 이룬다(명칭만 다르고
        // 의미 동일 — 혼동 방지).
        lastRepliedAt: r.latestReplyAt?.toISOString() ?? null,
        recentReplyUserIds: r.recentReplyUserIds ?? [],
        // S36 (FR-TH-04): per-viewer 미읽 여부. viewerId 미전달 시 SQL 이 false
        // 리터럴을 반환하므로 그대로 false.
        hasUnread: r.hasUnread === true,
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

  /**
   * S17 (FR-DM-13): 이미 열린 1:1 DM 에 send 시점 BLOCKED 재검증. S16
   * assertCanDm 은 DM *개설* 시 ACCEPTED 를 요구하지만, 그 이후 한쪽이
   * 차단하면 채널은 그대로 살아있다 — send 경로에서 매번 재검증해야 한다.
   *
   * 차단 = Friendship status='BLOCKED'. 양방향 거부: 내가 상대를 차단했거나
   * (requesterId=author) 상대가 나를 차단했거나(addresseeId=author) 둘 다
   * 전송 불가. blocker/blocked 어느 쪽인지는 응답에 노출하지 않기 위해 중립
   * 메시지 + FRIEND_BLOCKED(403)로 통일한다.
   *
   * 1:1 DM 에만 적용한다(채널명 `gdm:` 아님). 그룹 DM 은 멤버 1인 차단으로
   * 그룹 전체 전송을 막지 않으며, 대신 FR-DM-18 마스킹으로 처리한다. 비-DIRECT
   * 채널은 무동작.
   *
   * NOTE: 송신 hot-path 에 채널 조회 1회를 추가하지 않도록, 이 게이트는
   * `send()` 내부가 아니라 DM 컨텍스트를 이미 아는 컨트롤러(GlobalDmMessages
   * Controller / 워크스페이스 MessagesController 의 DIRECT 분기)에서만 호출한다.
   * 일반 텍스트 채널 송신은 이 메서드를 거치지 않는다.
   *
   * perf (S17 review): 채널 메타(type/name)는 두 컨트롤러의 guard
   * (DmChannelAccessGuard / ChannelAccessGuard)가 이미 로드해 req.channel 에
   * 실어 두므로, 중복 SELECT 를 피하려 호출측이 인자로 넘긴다. DIRECT/`gdm:`
   * 판정은 전달받은 메타로 한다 — send hot-path 채널 재조회 0회.
   */
  async assertNotBlockedForDmSend(
    channelId: string,
    authorId: string,
    channelMeta: { type: string; name: string | null },
  ): Promise<void> {
    if (channelMeta.type !== 'DIRECT') return;
    if (channelMeta.name?.startsWith('gdm:')) return; // 그룹 DM 은 마스킹으로 처리.

    // 상대 참여자(USER override, 본인 제외) 조회.
    const peers = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId,
        principalType: 'USER',
        principalId: { not: authorId },
      },
      select: { principalId: true },
    });
    const peerIds = peers.map((p) => p.principalId);
    if (peerIds.length === 0) return;

    const blocked = await this.prisma.friendship.findFirst({
      where: {
        status: 'BLOCKED',
        OR: [
          { requesterId: authorId, addresseeId: { in: peerIds } },
          { requesterId: { in: peerIds }, addresseeId: authorId },
        ],
      },
      select: { id: true },
    });
    if (blocked) {
      // 중립 처리: blocker/blocked 방향 비노출.
      throw new DomainError(ErrorCode.FRIEND_BLOCKED, 'cannot send: not permitted');
    }
  }

  // ------------------------------------------------- S17 DM visibility/block

  /**
   * S17 (FR-DM-17 / FR-TH-19): 요청자의 DM 가시성 하한선(visibleFrom)을
   * 조회한다. DM 멤버십은 ChannelPermissionOverride 의 USER-principal row
   * 로 표현되므로(S16), 그 row 의 visibleFrom 을 그대로 반환한다. DIRECT
   * 가 아닌 채널·멤버십 row 부재·legacy DM row(NULL)는 모두 null 을 돌려
   * 필터가 무영향이게 한다. 호출측(list 컨트롤러)이 ListMessagesArgs.visibleFrom
   * 으로 넘긴다.
   */
  async resolveDmVisibleFrom(channelId: string, userId: string): Promise<Date | null> {
    const override = await this.prisma.channelPermissionOverride.findFirst({
      where: { channelId, principalType: 'USER', principalId: userId },
      select: { visibleFrom: true },
    });
    return override?.visibleFrom ?? null;
  }

  /**
   * S17 (FR-DM-18): blocker(요청자)가 BLOCKED 한 상대 userId 집합을 단일
   * SELECT 로 로드한다(N+1 회피). 차단 = Friendship status='BLOCKED' 이며
   * blocker 는 항상 requesterId 다(friends.service 의 block 이 row 를 그렇게
   * 정렬). 따라서 `requesterId=blockerId AND status='BLOCKED'` 의 addresseeId
   * 를 모은다. 그룹 DM 메시지 목록 마스킹에 사용한다.
   */
  async loadBlockedUserIds(blockerId: string): Promise<Set<string>> {
    const rows = await this.prisma.friendship.findMany({
      where: { requesterId: blockerId, status: 'BLOCKED' },
      select: { addresseeId: true },
    });
    return new Set(rows.map((r) => r.addresseeId));
  }

  /**
   * S17 (FR-DM-18): authorId 가 blocked-set 에 든 메시지의 본문을 placeholder
   * 로 마스킹한다(삭제 아님 — 자리 유지). content/contentRaw/contentAst 를
   * 일관 치환해 라이브 렌더러와 정규식 폴백 둘 다 placeholder 를 표시하게 한다.
   * deleted 메시지는 이미 toDto 가 null 로 마스킹했으므로 건드리지 않는다.
   *
   * NIT (S17 review): mentions 도 빈 값으로 비운다. placeholder 로 본문을 가려도
   * mentions.users/everyone/here 가 살아있으면 마스킹된 메시지가 멘션 badge 를
   * 점등시키거나 멘션 패널/언리드에 차단 author 의 흔적을 남긴다. content 와
   * 동일하게 비노출 처리한다(reactions/thread 메타는 count·emoji 집계라 author
   * 정체를 드러내지 않으므로 유지 — 단방향 마스킹 정책과 일관).
   *
   * NOTE (단방향 마스킹 정책 — 의도된 동작): blocked-set 은 `loadBlockedUserIds`
   * 가 "내가(blocker=requesterId) 차단한 상대"만 모은다. 즉 내가 차단한 사람의
   * 메시지만 *나에게* 마스킹되고, 나를 차단한 상대에게는 내 메시지가 그대로
   * 보인다 — Discord 의 차단 의미(상호 숨김 아님)와 동일하다.
   */
  maskBlockedAuthors(dtos: MessageDto[], blockedIds: Set<string>): MessageDto[] {
    if (blockedIds.size === 0) return dtos;
    return dtos.map((dto) => {
      if (!blockedIds.has(dto.authorId) || dto.deleted) return dto;
      return {
        ...dto,
        content: BLOCKED_MESSAGE_PLACEHOLDER,
        contentRaw: BLOCKED_MESSAGE_PLACEHOLDER,
        contentAst: null,
        // S37 (FR-MSG-17): 평문 정본도 placeholder 로 치환 — content 와 동일하게
        // 차단 author 의 본문이 "메시지 복사" 로 새지 않도록 한다.
        contentPlain: BLOCKED_MESSAGE_PLACEHOLDER,
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
      };
    });
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
    // S20 (MAJOR/perf fix-forward): caller-provided channel type so the DM
    // hidden-restore gate skips the per-send `channel.findUnique`. Both send
    // controllers already hold the channel meta on req.channel (the
    // assertNotBlockedForDmSend S17 precedent), so they pass `channel.type`
    // through here. When omitted we fall back to `workspaceId === null`
    // (a DM is workspaceless) to keep older callers correct.
    channelType?: string;
    // S21 (FR-RS-16): composer 가 멘션 피커로 선택한 특수멘션 힌트. 본문에
    // sigil 이 없어도(피커 선택만) 특수멘션 의도를 반영하기 위해 OR 로 병합한 뒤
    // gate.ts 로 권한 게이트한다. user/channel(이름) 멘션은 본문에서 권위적으로
    // 재추출되므로 힌트로 받지 않는다(신뢰 경계 유지).
    mentionsHint?: { everyone?: boolean; here?: boolean; channel?: boolean };
    // S35 (FR-TH-06): 'Also send to #channel'. parentMessageId(=답글)와 함께
    // true 면, send tx 안에서 별도의 SYSTEM_THREAD_BROADCAST 행을 채널 타임라인에
    // 동시 게시한다. parentMessageId 없이 true 면 무시한다(루트/일반 send 에는
    // broadcast 개념 없음 — 컨트롤러도 답글에만 전달하지만 서비스에서도 가드).
    // broadcast 행의 content 는 답글 본문 복제이고 SYSTEM 템플릿을 쓰지 않으므로
    // actor username 은 필요 없다(클라가 레이블/excerpt 만 별도 렌더).
    isBroadcast?: boolean;
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
    // S29 (FR-S05): 같은 쿼리에서 kind 를 가져와 hasImage/hasFile 비정규화
    // 플래그를 계산한다(추가 round-trip 없음).
    let attachmentKinds: AttachmentKind[] = [];
    if (args.attachmentIds && args.attachmentIds.length > 0) {
      const rows = await this.prisma.attachment.findMany({
        where: {
          id: { in: args.attachmentIds },
          channelId: args.channelId,
          uploaderId: args.authorId,
          finalizedAt: { not: null },
          messageId: null,
        },
        select: { id: true, kind: true },
      });
      if (rows.length !== args.attachmentIds.length) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_NOT_FOUND,
          'one or more attachments are not finalized or already linked',
        );
      }
      attachmentKinds = rows.map((r) => r.kind);
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
    const extracted = await extractMentions(this.prisma, args.workspaceId, args.content);
    // S21 (FR-RS-16): 특수멘션은 본문 sigil 추출값과 composer 힌트를 OR 병합한다.
    // user/channel(이름) 멘션은 본문 권위 추출만 신뢰한다(힌트 미반영). DM
    // 채널(workspaceId=null)은 extractMentions 가 전부 false 를 반환하므로 힌트도
    // 무의미 — 병합 후에도 false 로 유지된다(멘션 네임스페이스 부재).
    const hint = args.workspaceId === null ? undefined : args.mentionsHint;
    const rawMentions: typeof extracted = {
      ...extracted,
      everyone: extracted.everyone || hint?.everyone === true,
      here: extracted.here || hint?.here === true,
      channel: extracted.channel || hint?.channel === true,
    };
    // task-044-iter3 + S21: 권한 없는 특수멘션(@everyone/@here/@channel)은 송신
    // 역할 게이트로 silently false 다운그레이드. Default `MEMBER` 으로 보수적
    // 처리 — DM 채널 등 actorRole 미정 호출도 자동 거부됩니다.
    const mentions = gateChannelMention(
      gateHereMention(
        gateEveryoneMention(rawMentions, args.actorRole ?? 'MEMBER'),
        args.actorRole ?? 'MEMBER',
      ),
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
    // S29 (FR-S05): 비정규화 검색 플래그 계산 — hasLink 는 AST 의 link 노드,
    // hasImage/hasFile 은 연결할 첨부 kind 집합에서 유도.
    const { hasImage, hasFile } = flagsFromAttachmentKinds(attachmentKinds);
    const hasLink = astHasLink(processed.contentAst);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // S34 (FR-TH-17): TOCTOU orphan 방어. 위 pre-tx findFirst 가 parent 를
        // 검증했지만, 검증과 tx 진입 사이에 루트가 soft-delete 될 수 있다(동시
        // 삭제 레이스). 답글이 INSERT 되고 나면 부모를 잃은 orphan 이 된다.
        //
        // S34 fix-forward (#2 perf CRITICAL): 종전엔 parent 행을 `FOR UPDATE` 로
        // 잠가 재검증했으나, 그 잠금은 commit 까지 루트 행에 유지되어 인기
        // 스레드의 동시 답글을 직렬화하는 hot-row 병목이었다. orphan(막 삭제된
        // 루트에 붙은 답글)은 사실상 무해하다: 삭제된 루트는 타임라인·스레드
        // 패널에 비가시이고, 비정규화 카운터(replyCount/latestReplyAt)는 아래
        // UPDATE 가 `WHERE deletedAt IS NULL` 가드라 삭제 루트에 매칭되지 않아
        // 영향이 없다. 따라서 잠금을 제거하고 tx 내 **비잠금** findUnique 로
        // 동일하게 재검증한다 — 흔한 경우(이미 삭제된 루트)는 그대로 거부해
        // 방어를 유지하면서 직렬화 비용만 없앤다. 검증과 INSERT 사이의
        // narrow-race 로 새는 잔여 orphan(극히 드묾)은 무해하며, 1시간 주기
        // reconcile 이 카운트 정합을 맞춘다(FR-TH-17).
        // S35 fix-forward (perf #7): 아래 broadcast 분기가 루트 excerpt 산정에
        // 쓸 루트 본문을 여기서 한 번에 읽어 재사용한다(루트 findUnique 2회 →
        // 1회). tx-top 재검증이 이미 channelId 일치를 강제하므로(F-03 보안), 이
        // 본문은 "동일 채널의 비삭제 루트"임이 보장된다.
        let parentContentForBroadcast: string | null = null;
        if (args.parentMessageId) {
          const parentNow = await tx.message.findUnique({
            where: { id: args.parentMessageId },
            select: { deletedAt: true, channelId: true, content: true },
          });
          if (
            !parentNow ||
            parentNow.deletedAt !== null ||
            parentNow.channelId !== args.channelId
          ) {
            // 삭제된(또는 사라진/타채널) 루트에 대한 답글은 거부한다. pre-tx
            // 검증과 동일한 도메인 에러로 통일해 클라이언트 분기가 일관되게 한다.
            throw new DomainError(
              ErrorCode.MESSAGE_PARENT_NOT_FOUND,
              'parent message not found in this channel',
            );
          }
          // 검증 통과 → 동일 채널의 비삭제 루트 본문을 broadcast excerpt 용으로
          // 보관(아래 broadcast 분기가 추가 findUnique 없이 재사용).
          parentContentForBroadcast = parentNow.content;
        }
        const created = await tx.message.create({
          data: {
            channelId: args.channelId,
            authorId: args.authorId,
            content: args.content,
            contentPlain,
            // S29 (FR-S05): 검색 has: 필터용 비정규화 플래그.
            hasLink,
            hasImage,
            hasFile,
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
            // S37 (FR-MSG-17): 평문 정본 e2e 전파. send 시 파싱한 contentPlain 을
            // 그대로 실어 라이브 수신측 캐시가 "메시지 복사" 평문 정본을 갖게 한다.
            contentPlain,
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
        // S28 (FR-P05/P06): DND 알림 차단 게이트. 수신자가 수동 DND(presencePreference
        // = dnd) 이거나 DND 스케줄 구간이 send-time 에 활성이면 mention.received outbox
        // 자체를 스킵한다(mute 와 동일하게 fanout 비용도 절약). 같은 tx 안에서 후보의
        // presencePreference + dndSchedule 을 한 번에 조회해 atomic snapshot 을 보장한다.
        const dndRows =
          dedupedMentionUserIds.length === 0
            ? []
            : await tx.user.findMany({
                where: { id: { in: dedupedMentionUserIds } },
                select: { id: true, presencePreference: true, dndSchedule: true },
              });
        const dndSuppressedSet = new Set(
          dndRows
            .filter((r) =>
              isDndSuppressed(
                {
                  presencePreference: r.presencePreference,
                  dndSchedule: (r.dndSchedule as DndSchedule | null) ?? null,
                },
                now,
              ),
            )
            .map((r) => r.id),
        );
        const mentionedUserIds = new Set<string>();
        for (const uid of dedupedMentionUserIds) {
          if (mutedSet.has(uid)) continue;
          if (dndSuppressedSet.has(uid)) continue;
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

        // S33 (FR-TH-16 / FR-TH-17): 답글이면 같은 $transaction 안에서 루트의
        // 비정규화 카운터를 원자적으로 갱신한다. `replyCount = replyCount + 1`
        // 은 PostgreSQL 원자 UPDATE 라 동일 루트 동시 답글에도 안전하다(PRD
        // 동시성 엣지). `deletedAt IS NULL` 가드로 루트가 동시 soft-delete 된
        // 경우(매칭 0행) no-op — 이미 삭제된 루트의 카운터를 되살리지 않는다.
        //
        // S33 fix-forward (MAJOR-1): latestReplyAt 동시성 stale-write 수정.
        // 종전엔 `latestReplyAt = created.createdAt` 로 절대 set 했는데, 동시
        // 답글 두 건이 서로 다른 tx 에서 시작하면(각 tx-start 의 now() 가 곧
        // createdAt) 커밋 순서와 createdAt 순서가 어긋나 더 *과거* createdAt 의
        // 답글이 더 *최신* 값을 덮어쓸 수 있었다(마지막 답글 시각이 뒤로 감김).
        // softDelete 의 GREATEST(0, …) 패턴과 일관되게, latestReplyAt 도
        // `GREATEST(COALESCE(기존, -infinity), 새 createdAt)` 로 단조 증가만
        // 허용한다 — 과거값은 절대 최신값을 못 덮는다. raw UPDATE 로 표현한다
        // (Prisma 빌더는 GREATEST 미지원). replyCount 증가는 그대로 원자적.
        if (created.parentMessageId) {
          await tx.$executeRaw`
            UPDATE "Message"
               SET "replyCount" = "replyCount" + 1,
                   "latestReplyAt" = GREATEST(
                     COALESCE("latestReplyAt", '-infinity'::timestamptz),
                     ${created.createdAt}
                   )
             WHERE id = ${created.parentMessageId}::uuid
               AND "deletedAt" IS NULL
          `;
        }

        // S34 (FR-TH-07): @멘션 자동 구독. 스레드 답글(parentMessageId 보유)에서
        // @멘션된 사용자를 같은 $transaction 안에서 스레드 루트의 follower 로
        // upsert 한다. PRD: "스레드 시작자·답글 작성자·@멘션된 사용자 자동 구독".
        // 시작자/답글 작성자는 위 task-047 자동 follow 가 이미 처리하므로 여기선
        // 멘션 대상만 처리한다. 루트 메시지의 @멘션은 구독할 thread 컨텍스트가
        // 없으므로(루트는 자기 자신이 thread parent) 스킵한다 — 답글에만 적용.
        //
        // 비-치명 패턴: 기존 authorId 자동 follow 와 동일하게 `.catch(()=>undefined)`
        // 로 감싼다. subscribe 는 (userId, threadParentId) upsert(중복 무시)라
        // 일반적으로 throw 하지 않지만(자기 자신/이미 구독자 무해), 만에 하나
        // 멘션 대상이 채널 READ 권한이 없어(예: 비공개 채널 비멤버) subscribe 가
        // throw 해도 답글 INSERT 자체를 롤백시키지 않게 한다. 멘션 정규화가
        // 워크스페이스 멤버만 resolve 하므로 실사용에선 대부분 통과한다.
        //
        // `mentionedUserIds` 는 위에서 self/mute/DND 필터를 거친 집합이지만,
        // 자동 구독은 알림 게이트(mute/DND)와 독립이다(구독은 알림 ON/OFF 보다
        // 상위 개념 — 뮤트해도 스레드 팔로우 자체는 유지). 따라서 게이트 이전의
        // dedupedMentionUserIds(self 제외 + distinct)를 구독 대상으로 쓴다.
        //
        // S34 fix-forward (security #3): 단, 작성자가 차단했거나(blocker) 작성자를
        // 차단한(blocked) 사용자는 자동 구독 대상에서 제외한다. 차단 관계의
        // 상대를 멘션만으로 스레드 follower 로 끌어들이면 이후 N2 dispatcher 가
        // 그 스레드의 새 답글 알림을 차단 상대에게 발송해 프라이버시를 깬다.
        // loadBlockedUserIds 는 "내가(작성자) 차단한 상대"를 모으는 단방향
        // 헬퍼지만, 여기서는 양방향(내가 차단/상대가 차단) 모두 제외해야 하므로
        // 같은 tx 안에서 BLOCKED Friendship 을 양방향으로 조회한다(atomic
        // snapshot). authorId follow 는 자기 자신이라 이 게이트와 무관하다.
        if (
          created.parentMessageId &&
          this.threadSubscriptions &&
          dedupedMentionUserIds.length > 0
        ) {
          const threadRootId = created.parentMessageId;
          const blockedRows = await tx.friendship.findMany({
            where: {
              status: 'BLOCKED',
              OR: [
                { requesterId: args.authorId, addresseeId: { in: dedupedMentionUserIds } },
                { requesterId: { in: dedupedMentionUserIds }, addresseeId: args.authorId },
              ],
            },
            select: { requesterId: true, addresseeId: true },
          });
          const blockedSet = new Set<string>();
          for (const r of blockedRows) {
            // 작성자가 아닌 쪽이 곧 차단 관계의 상대(멘션 대상).
            blockedSet.add(r.requesterId === args.authorId ? r.addresseeId : r.requesterId);
          }
          for (const uid of dedupedMentionUserIds) {
            if (blockedSet.has(uid)) continue; // 차단/피차단 상대는 자동구독 제외.
            await this.threadSubscriptions
              .subscribe({
                userId: uid,
                threadParentId: threadRootId,
                tx: tx as Parameters<ThreadSubscriptionsService['subscribe']>[0]['tx'],
              })
              .catch(() => undefined); // 멘션 자동 구독 실패는 비-치명(답글 INSERT 유지).
          }
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

        // S35 (FR-TH-06): 'Also send to #channel' broadcast. 답글(parentMessageId
        // 보유) + isBroadcast 일 때만, 같은 $transaction 안에서 별도의
        // SYSTEM_THREAD_BROADCAST 행을 채널 타임라인에 동시 게시한다. 이 행은:
        //   - isBroadcast=true (채널 가시성·FR-TH-14 미읽 분기 키)
        //   - parentMessageId = thread root (클릭 시 스레드 열림 + 루트 excerpt 출처)
        //   - content/contentRaw/contentAst = 방금 보낸 답글 본문(채널에서 답글
        //     본문이 그대로 보이도록 — PRD "스레드 메시지를 채널에 게시")
        //   - authorType = SYSTEM, type = SYSTEM_THREAD_BROADCAST (시스템 행 렌더
        //     규약과 정합 — 클라가 레이블 + excerpt 분기)
        // 트랜잭션 실패 시 답글과 함께 롤백된다(FR-TH-17 원자성과 일관).
        if (created.parentMessageId && args.isBroadcast === true) {
          // S35 fix-forward (perf #7 + 보안 F-03): 루트 excerpt(50자)는 위
          // tx-top 재검증이 읽어둔 본문(parentContentForBroadcast)을 재사용한다.
          // 그 본문은 "동일 채널(channelId === args.channelId)의 비삭제 루트"임이
          // 이미 보장되므로, 별도 findUnique(루트 2회 조회) 없이 channelId-스코프된
          // excerpt 를 산정할 수 있다. parentContentForBroadcast 가 null 인 경우는
          // 정상 흐름상 없지만(여기 도달 == 검증 통과), 방어적으로 빈 문자열을 쓴다.
          const parentExcerpt = buildThreadBroadcastExcerpt(parentContentForBroadcast);
          const broadcast = await tx.message.create({
            data: {
              channelId: args.channelId,
              authorId: args.authorId,
              authorType: 'SYSTEM',
              type: 'SYSTEM_THREAD_BROADCAST',
              isBroadcast: true,
              // 답글 본문을 그대로 복제 — 채널 타임라인에서 답글 내용이 보인다.
              content: args.content,
              contentPlain,
              contentRaw: normalizedContent,
              contentAst: processed.contentAst as unknown as Prisma.InputJsonValue,
              contentPlainV2: contentPlain,
              hasLink,
              hasImage,
              hasFile,
              // 스레드 루트로 링크 — 클릭 시 스레드 열림. 단, broadcast 행은
              // 답글이 아니므로 루트 replyCount 에는 산입하지 않는다(아래 카운터
              // UPDATE 는 위 답글 INSERT 분기에서 이미 수행됨 — broadcast 는 별개).
              parentMessageId: created.parentMessageId,
              // broadcast 행은 채널 미읽 분기 대상이지 멘션 fanout 대상이 아니므로
              // mentions 는 비운다(답글 본인이 이미 mention.received 를 받았다).
              mentions: {
                users: [],
                channels: [],
                everyone: false,
                here: false,
                channel: false,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          const broadcastPayload: MessageThreadBroadcastPayload = {
            workspaceId: args.workspaceId,
            channelId: args.channelId,
            actorId: args.authorId,
            parentMessageId: created.parentMessageId,
            parentExcerpt,
            message: {
              id: broadcast.id,
              authorId: broadcast.authorId,
              content: broadcast.content,
              contentRaw: broadcast.contentRaw ?? broadcast.content,
              contentAst: processed.contentAst,
              type: broadcast.type,
              mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
              createdAt: broadcast.createdAt.toISOString(),
              parentMessageId: broadcast.parentMessageId,
              isBroadcast: true,
            },
          };
          await this.outbox.record(tx, {
            aggregateType: 'Message',
            aggregateId: broadcast.id,
            eventType: MESSAGE_THREAD_BROADCAST,
            payload: broadcastPayload,
          });
        }

        // S20 (FR-DM-10): DM hidden-restore. 상대방의 새 메시지가 도착하면 그 DM 을
        // 숨겼던 수신자(보낸 본인 제외)의 hiddenAt 을 NULL 로 자동 복원한다. DIRECT
        // 채널일 때만 동작하며, 같은 send 트랜잭션 안에서 처리해 메시지 INSERT 와
        // 원자적이다. visibleFrom 은 건드리지 않으므로 과거 메시지는 그대로 보인다
        // (숨김만 해제).
        //
        // S20 (MAJOR/perf fix-forward): hot-path 에서 매 전송마다 channel.findUnique
        // 를 발행하던 것을 제거한다. 두 send 컨트롤러가 이미 보유한 channel.type 을
        // 넘기면 그것으로, 없으면 workspaceId === null(= DM)로 게이트한다. updateMany
        // 는 `hiddenAt:{not:null}` 가드라 비-DIRECT(항상 NULL)에 매칭이 없어 무회귀지만,
        // 불필요한 UPDATE 자체를 피하려 타입 판정 후에만 실행한다.
        const isDirect =
          args.channelType === undefined
            ? args.workspaceId === null
            : args.channelType === 'DIRECT';
        if (isDirect) {
          await tx.channelPermissionOverride.updateMany({
            where: {
              channelId: args.channelId,
              principalType: 'USER',
              principalId: { not: args.authorId },
              hiddenAt: { not: null },
            },
            data: { hiddenAt: null },
          });
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
    // S33 (FR-TH-16): 루트 메타를 비정규화 컬럼에서 직접 읽는다. 이 호출은 위
    // send tx 의 `replyCount +1 / latestReplyAt = 답글 createdAt` UPDATE 뒤에
    // 일어나므로 두 컬럼은 방금 INSERT 한 답글을 이미 반영한다 — 별도 COUNT/MAX
    // 집계 쿼리를 돌리지 않는다(GROUP BY 제거).
    const root = await tx.message.findUnique({
      where: { id: rootId },
      select: { authorId: true, deletedAt: true, replyCount: true, latestReplyAt: true },
    });
    if (!root || root.deletedAt) return null;

    const replyCount = root.replyCount;
    const lastAt = root.latestReplyAt ?? replyCreatedAt;

    // recipients 산정에는 여전히 최근 distinct repliers 목록이 필요하므로 이
    // bounded 쿼리는 유지한다(루트 1쿼리, LIMIT 200 으로 bound). DISTINCT 로
    // 한 명이 수신자 슬롯을 다 먹지 않게 한다.

    const recent = await tx.$queryRaw<{ authorId: string }[]>(Prisma.sql`
      SELECT DISTINCT ON ("authorId") "authorId"
        FROM (
          SELECT "authorId", "createdAt"
            FROM "Message"
           WHERE "parentMessageId" = ${rootId}::uuid
             AND "deletedAt" IS NULL
             -- S35 fix-forward: broadcast 행은 답글이 아니므로 thread.replied
             -- recipient 산정에서 제외한다(phantom recipient 방지).
             AND "isBroadcast" = false
           ORDER BY "createdAt" DESC
           LIMIT 200
        ) latest
       ORDER BY "authorId", "createdAt" DESC
    `);
    // S33 (FR-TH-03/16): 아바타 스택용 최근 답글자 — cap 5(THREAD_REPLY_
    // PARTICIPANT_CAP). outbox payload 는 bounded 유지. 라이브 thread:reply:new
    // 수신측이 reply bar 의 replyParticipants(≤5)를 갱신한다.
    const recentReplyUserIds = recent.slice(0, THREAD_REPLY_PARTICIPANT_CAP).map((r) => r.authorId);

    // Recipients: root author first so the dispatcher can check mail
    // priority cheaply, then up to 19 recent repliers, deduped, with
    // author self-filter + already-mentioned filter applied.
    const candidate: string[] = [];
    const seen = new Set<string>();
    const push = (uid: string) => {
      if (!uid || uid === replierId) return;
      if (excludeRecipients.has(uid)) return;
      if (seen.has(uid)) return;
      seen.add(uid);
      candidate.push(uid);
    };
    push(root.authorId);
    for (const { authorId } of recent) {
      if (candidate.length >= THREAD_REPLY_RECIPIENT_CAP) break;
      push(authorId);
    }

    // S28 (reviewer M3 fix-forward): thread.replied 수신자에도 DND 게이트를
    // 적용한다(mention.received 와 동일 정책). 수신자가 수동 DND 이거나 send-time 에
    // DND 스케줄 구간이 활성이면 thread.replied 후보에서 제외한다. 같은 tx 안에서
    // presencePreference + dndSchedule 을 한 번에 조회해 atomic snapshot 을 보장한다
    // (mention 게이트와 같은 read 패턴). 빈 후보면 조회 생략.
    //
    // S38 (FR-TH-08): notificationLevel fanout 필터. 같은 tx 안에서 후보들의
    // ThreadSubscription.notificationLevel 을 한 번에 조회해(원자적 snapshot)
    //   - OFF      → thread.replied 수신에서 제외(알림 없음).
    //   - MENTIONS → 제외. MENTIONS 구독자는 본인이 @멘션된 답글에서만 알림을
    //                받는데, 멘션 알림은 mention.received 가 담당하며(그 대상은
    //                excludeRecipients 로 이미 thread.replied 에서 빠진다), 멘션
    //                아닌 일반 답글은 알림이 없어야 하므로 thread.replied 후보에서
    //                전면 제외한다(OFF 와 동일하게 "새 답글 알림 없음", 멘션 시는
    //                별도 mention.received 로 도달).
    //   - ALL/구독행 없음 → 통과(자동 구독이 ALL 로 행을 만들지만, 레이스로 행이
    //                아직 없어도 ALL 로 간주해 알림 누락을 막는다 — 보수적 기본값).
    const recipients =
      candidate.length === 0
        ? candidate
        : await (async () => {
            const [dndRows, subRows] = await Promise.all([
              tx.user.findMany({
                where: { id: { in: candidate } },
                select: { id: true, presencePreference: true, dndSchedule: true },
              }),
              tx.threadSubscription.findMany({
                where: { threadParentId: rootId, userId: { in: candidate } },
                select: { userId: true, notificationLevel: true },
              }),
            ]);
            const suppressed = new Set(
              dndRows
                .filter((r) =>
                  isDndSuppressed(
                    {
                      presencePreference: r.presencePreference,
                      dndSchedule: (r.dndSchedule as DndSchedule | null) ?? null,
                    },
                    replyCreatedAt,
                  ),
                )
                .map((r) => r.id),
            );
            // OFF / MENTIONS 구독자는 thread.replied 수신 제외(FR-TH-08).
            const mutedByLevel = new Set(
              subRows
                .filter((r) => r.notificationLevel === 'OFF' || r.notificationLevel === 'MENTIONS')
                .map((r) => r.userId),
            );
            return candidate.filter((uid) => !suppressed.has(uid) && !mutedByLevel.has(uid));
          })();

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
      channel: false,
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
          // S37 (FR-MSG-17): 시스템 메시지의 평문 정본도 전파(타입 일관 — 복사
          // 메뉴는 시스템 행에 노출되지 않지만 캐시 DTO 형태를 통일한다).
          contentPlain: processed.contentPlain,
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
    // S17 (FR-DM-17 / FR-TH-19): 가시성 하한선. 모든 하위 경로(around split
    // 포함)의 rawList 호출에 그대로 전달한다.
    const visibleFrom = args.visibleFrom ?? null;

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
        where: {
          id: args.around,
          channelId,
          // S17 NIT (info-leak oracle): anchor 도 visibleFrom 게이트를 거친다.
          // 게이트가 없으면 `around=<visibleFrom 이전 msgId>` 가 200(빈 윈도)을,
          // 존재하지 않는 id 는 404 를 돌려 "그 시각 이전에 메시지가 존재하는가"를
          // 200/404 로 구분하는 oracle 이 된다. visibleFrom 이전 anchor 는 list
          // 와 동일하게 MESSAGE_NOT_FOUND 로 통일한다.
          ...(visibleFrom ? { createdAt: { gte: visibleFrom } } : {}),
        },
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
        // S17 (FR-TH-19): around 의 contextBefore 도 visibleFrom 이전 메시지를
        // 제외한다 — anchor 가 visibleFrom 이후여도 더 과거 컨텍스트가 새지 않게.
        visibleFrom,
      });
      const afterItems = await this.rawList({
        channelId,
        direction: 'after',
        cursor: { createdAt: anchor.createdAt.toISOString(), id: anchor.id },
        inclusive: false,
        limit: half,
        includeDeleted,
        visibleFrom,
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
      visibleFrom,
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
    // S17 (FR-DM-17 / FR-TH-19): 요청자 DM 가시성 하한선. null = 무필터.
    visibleFrom?: Date | null;
  }): Promise<MessageRow[]> {
    const params: unknown[] = [args.channelId, args.limit];
    // S33 (FR-MSG-09 carryover): 답글이 달린 thread-root 가 soft-delete 되면
    // 채널 목록에서 제외하지 말고 placeholder 로 유지한다(답글이 부모를 잃지
    // 않도록 — PRD "루트 소프트삭제 후 스레드" 엣지). `replyCount > 0` 인 삭제
    // 루트만 살린다(단독 메시지는 기존대로 즉시 제거). toDto 가 deleted:true +
    // content null 로 마스킹하되 thread 메타(replyCount/latestReplyAt)는 유지해
    // reply bar 가 계속 노출된다. includeDeleted=true(모더레이터)는 무필터 그대로.
    const deletedFilter = args.includeDeleted
      ? ''
      : 'AND ("deletedAt" IS NULL OR "replyCount" > 0)';

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

    // S17 (FR-DM-17 / FR-TH-19): DM 가시성 하한선. visibleFrom 이 설정되면
    // `createdAt >= visibleFrom` 으로 그 시각 이전 메시지를 모든 경로에서
    // 제외한다. 파라미터 번호는 cursor 유무에 따라 달라지므로(있으면 $5,
    // 없으면 $3) 동적으로 부여한다. NULL/undefined 면 절을 아예 비워 비-DM
    // 채널·legacy DM 에는 무영향이다.
    let visibleFromSql = '';
    if (args.visibleFrom) {
      params.push(args.visibleFrom);
      const idx = params.length;
      visibleFromSql = `AND "createdAt" >= $${idx}::timestamptz`;
    }

    // task-014-B: channel list is ROOTS ONLY. Replies live behind the
    // thread panel. Partial index `Message_channel_roots_idx` keeps
    // this on an index scan; without the predicate EXPLAIN showed a
    // seq scan once replies outnumbered roots.
    //
    // S35 (FR-TH-06): broadcast 예외. broadcast 행(SYSTEM_THREAD_BROADCAST)은
    // parentMessageId(=스레드 루트)를 가지지만 채널 타임라인에 노출되어야 하므로
    // roots-only 필터에 `OR "isBroadcast"` 를 더한다. broadcast 행은 채널 정렬
    // 위치(createdAt)에 그대로 끼며, 일반 답글은 여전히 제외된다(답글은
    // isBroadcast=false 라 두 조건 모두 불만족).
    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain", "contentPlainV2",
             "contentRaw", "contentAst", "type", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey", "parentMessageId",
             "pinnedAt", "pinnedBy", "version", "isBroadcast", "threadLocked"
        FROM "Message"
       WHERE "channelId" = $1::uuid
             AND ("parentMessageId" IS NULL OR "isBroadcast" = true)
             ${deletedFilter}
             ${cursorSql}
             ${visibleFromSql}
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
    // S33 (FR-TH-15): 삭제된 답글도 placeholder 로 반환한다 — `deletedAt IS NULL`
    // 필터를 제거해 행을 포함하되, toDto 가 deleted:true + content 마스킹(본문 null)
    // 으로 처리하므로 본문은 새지 않는다. 클라이언트(ThreadReplyRow)는 deleted
    // 분기로 "(삭제된 답글)" placeholder 를 렌더한다. 커서 페이지네이션/limit/
    // hasMore/ASC 정렬은 그대로 유지(삭제 행도 시간순 자리를 지킨다 — 스레드
    // 맥락 보존). replyCount(FR-TH-16)는 비삭제만 세므로 카운트와는 별개다.
    // S35 (FR-TH-06): broadcast 행(SYSTEM_THREAD_BROADCAST)도 parentMessageId =
    // 루트를 갖지만 채널 타임라인 복제본이지 스레드 답글이 아니다 —
    // `AND "isBroadcast" = false` 로 스레드 패널 답글 목록에서 제외한다(broadcast
    // 가 스레드 안에서 자기 답글의 중복으로 보이지 않도록).
    const sql = `
      SELECT id, "channelId", "authorId", content, "contentPlain", "contentPlainV2",
             "contentRaw", "contentAst", "type", mentions,
             "editedAt", "deletedAt", "createdAt", "idempotencyKey", "parentMessageId",
             "pinnedAt", "pinnedBy", "version", "isBroadcast", "threadLocked"
        FROM "Message"
       WHERE "parentMessageId" = $1::uuid
             AND "isBroadcast" = false
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
    const mentions = gateChannelMention(
      gateHereMention(
        gateEveryoneMention(rawMentions, args.actorRole ?? 'MEMBER'),
        args.actorRole ?? 'MEMBER',
      ),
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
          // S29 (FR-S05): 편집으로 본문이 바뀌면 hasLink 재계산. 첨부는 편집
          // 경로에서 변경되지 않으므로 hasImage/hasFile 은 그대로 둔다.
          hasLink: astHasLink(processed.contentAst),
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
          // S37 (FR-MSG-17): 편집으로 재계산된 평문 정본 e2e 전파. 라이브 수신측
          // 캐시가 편집된 본문의 평문을 "메시지 복사" 정본으로 쓰게 한다.
          contentPlain,
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
    // S36 (FR-TH-14): tx 안에서 broadcast 여부를 캡처해, 커밋 후 동기 캐시 무효화
    // 여부를 결정한다. broadcast 행은 채널 unread 에 산입되므로 삭제 시 모든 멤버
    // 캐시를 즉시 비워야 한다(옵션 A). non-broadcast / no-op 삭제는 무효화 불필요.
    let deletedBroadcast = false;
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
      // count>0 → 같은 tx 안에서 방금 확정된 행이라 항상 존재. payload 용
      // authorId + S33 카운터 감소 분기용 parentMessageId 를 함께 읽는다.
      const updated = await tx.message.findUniqueOrThrow({
        where: { id: args.msgId },
        select: { id: true, authorId: true, parentMessageId: true, isBroadcast: true },
      });
      // S33 (FR-TH-16 / FR-TH-17): 삭제된 메시지가 답글이면 루트의 비정규화
      // replyCount 를 같은 $transaction 안에서 원자적으로 감소시킨다.
      // `GREATEST(0, replyCount - 1)` 로 음수를 방지(중복 삭제/drift 방어).
      // latestReplyAt 은 굳이 직전 답글로 되감지 않는다 — 마지막 답글이 삭제돼도
      // "마지막 활동 시각" 표시는 보수적으로 유지하고, 정확한 재계산은 1시간
      // 재집계 job(S34/운영)이 drift 로 정정한다(과도한 추가 쿼리 회피).
      // raw UPDATE 로 GREATEST 를 표현한다(Prisma 빌더는 GREATEST 미지원).
      //
      // S34 (FR-TH-17): WHERE 에 `AND "deletedAt" IS NULL` 가드를 추가한다.
      // 루트가 이미 soft-delete 됐다면 그 루트의 replyCount 는 더 이상 채널
      // 목록·스레드 패널의 reply bar 에 노출되지 않으므로(toDto 마스킹) 되감을
      // 필요가 없다. 가드 없이 무조건 GREATEST(0,…) UPDATE 를 돌리면 삭제된
      // 루트 행을 불필요하게 건드려(매칭 1행) 핫-로우 갱신을 유발하고, 답글의
      // 중복 soft-delete 가 이미 idempotent(상단 count===0 가드)인데도 루트
      // 카운터만 두 번 깎일 수 있는 표면적을 남긴다. 가드를 박아 "살아있는
      // 루트의 카운터만" 정정한다(이미 삭제된 루트는 매칭 0행 → no-op).
      //
      // S35 fix-forward (BLOCKER 정합): broadcast 행(isBroadcast=true)도
      // parentMessageId(=스레드 루트)를 가지지만, send 시 루트 replyCount 를
      // 올리지 *않았다*(broadcast 는 답글이 아니다). 따라서 broadcast 행을
      // soft-delete 할 때 루트 카운터를 깎으면 올린 적 없는 값을 차감해 음수
      // 방향 drift 를 만든다. `!updated.isBroadcast` 가드로 broadcast 삭제 시
      // 카운터를 건드리지 않는다 — send 의 "broadcast 는 replyCount 산입 안 함"
      // 과 대칭을 맞춘다.
      if (updated.parentMessageId && !updated.isBroadcast) {
        await tx.$executeRaw`
          UPDATE "Message"
             SET "replyCount" = GREATEST(0, "replyCount" - 1)
           WHERE id = ${updated.parentMessageId}::uuid
             AND "deletedAt" IS NULL
        `;
      }
      // S36 (FR-TH-14): 이번 삭제가 broadcast 행이었는지 캡처(count>0 가 보장한
      // 실제 삭제 1건에 한함 — 중복/no-op 삭제는 위 count===0 가드로 이미 return).
      deletedBroadcast = updated.isBroadcast === true;
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

    // S36 (FR-TH-14, 옵션 A 동기 직접): broadcast 행 삭제는 채널 unread 에서
    // 1건이 빠지므로($transaction 커밋 후, COUNT 재집계가 자동으로 −1), 영향
    // 받는 모든 멤버의 Redis 채널 unread 캐시를 즉시 무효화한다. 커밋 *후* 호출해
    // 무효화↔재집계 사이에 미커밋 상태가 노출되지 않게 한다. 무효화 실패 시
    // 캐시 TTL(2h) 자연 만료 + 다음 read-through DB 재집계가 정정한다(롤백 불요 —
    // unreadCount 는 DB COUNT 가 정본이라 캐시는 파생일 뿐). UnreadService 미주입
    // (단위 테스트)이면 생략한다.
    //
    // S36 fix-forward (perf SERIOUS): best-effort fire-and-forget. 전 멤버 fanout
    // 무효화를 동기 await 하면 대형 워크스페이스에서 softDelete HTTP 레이턴시가
    // 멤버 수에 비례해 늘어난다. 무효화는 파생 캐시 정리일 뿐(DB COUNT 가 정본)
    // 이라 hot-path 에서 분리해도 안전하다. 실패는 warn 으로 남기고, TTL/read-through
    // 가 정정한다.
    if (deletedBroadcast && this.unread) {
      void this.unread.invalidateChannelWorkspaceAllMembers(args.channelId).catch((err) => {
        this.logger.warn(
          `[messages] broadcast unread cache invalidation failed (channel=${args.channelId}): ${String(err).slice(0, 160)}`,
        );
      });
    }
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
   * S38 (FR-TH-13): 루트 메시지가 잠겨 있는지 조회한다. reply POST 게이트
   * (MessagesController.send)가 MEMBER 이하 차단 여부를 결정할 때 쓴다. 루트가
   * 없거나 답글 id 면 false(잠금은 루트에만 의미 — 답글-to-답글은 별도 깊이
   * 가드가 막는다). 단건 SELECT 라 send hot-path 오버헤드가 작다.
   */
  async isThreadLocked(rootId: string): Promise<boolean> {
    const row = await this.prisma.message.findUnique({
      where: { id: rootId },
      select: { threadLocked: true, parentMessageId: true },
    });
    return row?.parentMessageId === null && row?.threadLocked === true;
  }

  /**
   * S38 (FR-TH-13): 스레드 잠금/해제. 루트 메시지의 threadLocked 를 토글하고
   * thread:lock:changed(내부 dot 명 MESSAGE_THREAD_LOCK_CHANGED) 를 채널 룸으로
   * emit 한다. 권한(OWNER/ADMIN)은 컨트롤러 역할 게이트가 이미 통과시킨다(pin
   * 게이트 패턴과 일관 — service 오염 없음). 동일 상태로의 재호출은 idempotent
   * (no-op + 이벤트 미발행).
   *
   * 잠금은 루트 메시지에만 의미가 있으므로 parentMessageId IS NULL 인 루트만
   * 대상으로 한다(답글 id 로 호출 시 MESSAGE_NOT_FOUND).
   */
  async setThreadLock(args: {
    workspaceId: string | null;
    channelId: string;
    rootId: string;
    actorId: string;
    locked: boolean;
  }): Promise<{ parentMessageId: string; locked: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.message.findFirst({
        where: {
          id: args.rootId,
          channelId: args.channelId,
          parentMessageId: null,
          deletedAt: null,
        },
        select: { id: true, threadLocked: true },
      });
      if (!target) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
      }
      // idempotent: 이미 같은 상태면 갱신/이벤트 없이 현재 상태 반환.
      if (target.threadLocked === args.locked) {
        return { parentMessageId: target.id, locked: target.threadLocked };
      }
      const updated = await tx.message.update({
        where: { id: args.rootId },
        data: { threadLocked: args.locked },
        select: { id: true, threadLocked: true },
      });
      const payload: MessageThreadLockChangedPayload = {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        actorId: args.actorId,
        parentMessageId: updated.id,
        locked: updated.threadLocked,
      };
      await this.outbox.record(tx, {
        aggregateType: 'Message',
        aggregateId: updated.id,
        eventType: MESSAGE_THREAD_LOCK_CHANGED,
        payload,
      });
      return { parentMessageId: updated.id, locked: updated.threadLocked };
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
