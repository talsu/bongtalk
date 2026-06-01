import { z } from 'zod';
import { Cuid2Schema } from './mrkdwn';
import { RichTextRootSchema } from './mrkdwn-ast';
import { MessageTypeSchema } from './message-type';

export const MESSAGE_MAX_LENGTH = 4000;

export const MessageContentSchema = z.string().min(1).max(MESSAGE_MAX_LENGTH);

// 과도기(expand-contract) ID: 라이브 데이터는 아직 uuid, mrkdwn 파서는
// cuid2 토큰을 추출 → 둘 다 허용한다. S01 데이터 마이그레이션 완료 후
// Cuid2Schema 단독으로 좁힌다(현재 좁히면 라이브 uuid 멘션이 깨짐).
export const TransitionalIdSchema = z.string().uuid().or(Cuid2Schema);

export const MessageMentionsSchema = z.object({
  // ADR-1 / FR-RC22: 멘션 ID. 과도기엔 uuid|cuid2 둘 다 수용(위 NOTE).
  // 이전 `z.string().uuid()` 단독은 파서가 뽑은 cuid2 토큰을 거부해
  // MessageUpdatedPayload.mentions 가 런타임에서 깨졌다(리뷰 [H2]).
  // NOTE(S01): id/channelId/authorId 등 나머지 ID 필드 + 본 union 의
  // cuid2 단독 전환은 S01 마이그레이션에서 처리.
  users: z.array(TransitionalIdSchema),
  channels: z.array(TransitionalIdSchema),
  everyone: z.boolean(),
  // task-047 iter0 (HIGH-046-B carry-over): `@here` 멘션 — 채널 멤버 중
  // 현재 online 인 사람만. 046 iter8 에 extractor + gate 는 추가됐지만
  // schema/event payload 미플러밍 → 047 에서 e2e 보강. default(false)
  // 로 기존 row 의 forward-compat 보장 (DB JSONB 가 here 키 누락이어도
  // 응답 schema 에서 false 채움).
  here: z.boolean().default(false),
  // S21 fix-forward (FR-RS-16 · MAJOR-D): `@channel` 범위 멘션 — 현재 채널
  // 멤버 전원. mention-extractor 와 gate.ts 는 이미 `channel` 을 산출/게이트하나
  // 와이어 스키마에 누락돼 toMessageRow 가 드롭 → live 수신 시 dispatcher 의
  // isMention 이 @channel 을 무시해 배지가 reload 와 불일치했다. default(false)
  // 로 기존 row(channel 키 누락) forward-compat.
  channel: z.boolean().default(false),
});
export type MessageMentions = z.infer<typeof MessageMentionsSchema>;

// Opaque cursor (FR-MSG-21): base64url(JSON.stringify({ id, createdAt })). The
// UI MUST treat the string as an opaque token — encode/decode is server-side
// only.
//
// S03 NOTE(expand-contract wire compat): the canonical payload shape per
// FR-MSG-21 is `{ id, createdAt }`. The legacy slice shipped `{ t, id }`
// tokens, so the decoder accepts BOTH on the read path (a live client may
// still hold a `{ t, id }` token across the deploy) but the encoder only
// ever emits the canonical `{ id, createdAt }` form.
//
// NOTE(S03 review MAJOR #2): the cursor `id` is UUID-ONLY — NOT the
// transitional uuid|cuid2 union. `Message.id` is `@db.Uuid`, the API read path
// binds `$4::uuid` (a cuid2 cursor would throw a Postgres cast error), and
// `around` is `z.string().uuid()`. Loosening to cuid2 here was premature and
// inconsistent with the SQL/PK reality; if the S01 PK→cuid2 transition ever
// lands, re-loosen this schema, the API decoder, AND the SQL cast together.
export const CursorStringSchema = z.string().min(1).max(512);
// Canonical FR-MSG-21 payload. `createdAt` is an ISO-8601 instant; `id` is a
// uuid (matches the live `@db.Uuid` PK + the `$4::uuid` read-path cast).
export const CursorIdSchema = z.string().uuid();
export const CursorPayloadSchema = z.object({
  id: CursorIdSchema,
  createdAt: z.string().datetime(),
});
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

// Task-013-B: per-message reaction summary. `byMe` is viewer-scoped so
// the same message row can serialize differently depending on which
// authenticated user hits the endpoint.
export const ReactionSummarySchema = z.object({
  emoji: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  byMe: z.boolean(),
});
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

// Task-014-B: root messages expose a thread summary. All three fields
// come from the same GROUP BY aggregate over replies — replyCount is
// the COUNT, lastRepliedAt the MAX(createdAt), recentReplyUserIds the
// last 3 distinct authors (for the avatar stack). `null`/`[]` when
// there are no replies yet so the UI can suppress the summary row.
export const ThreadSummarySchema = z.object({
  replyCount: z.number().int().nonnegative(),
  lastRepliedAt: z.string().datetime().nullable(),
  recentReplyUserIds: z.array(z.string().uuid()).max(3),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

// Trimmed Attachment projection embedded on each MessageDto. The
// upload flow stays the same (presigned upload + finalize), but the
// message list endpoint now returns the attachments inline so the UI
// can render images / videos / file cards without an extra fan-out.
// Mirrors `apps/web/src/features/messages/AttachmentsList.tsx`'s
// AttachmentLite interface.
export const AttachmentLiteSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['IMAGE', 'VIDEO', 'FILE']),
  mime: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  originalName: z.string().min(1).max(512),
});
export type AttachmentLite = z.infer<typeof AttachmentLiteSchema>;

export const MessageDtoSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  content: MessageContentSchema.nullable(),
  // S02 (ADR-2 / FR-RC02): rich content 송수신 코어. 기존 `content` 와
  // 병행하는 additive 필드 — 구 클라이언트는 무시하고 신규 렌더러는
  // contentAst 를 우선 사용합니다. 서버가 채우기 전 row(또는 SYSTEM 메시지)
  // 는 둘 다 null 이라 forward-compat. deleted 메시지는 마스킹되어 null.
  contentRaw: z.string().nullable().default(null),
  contentAst: RichTextRootSchema.nullable().default(null),
  // S04 (ADR-2 / FR-MSG-19 / FR-RC10): 메시지 타입. 기존 row 와 구
  // 클라이언트는 DEFAULT 로 forward-compat. SYSTEM_* 타입은 렌더러가
  // 시스템 행(아이콘 + 이탤릭, 편집·삭제 미표시)으로 표시하고 그루핑에서
  // grouped=false 를 강제합니다.
  type: MessageTypeSchema.default('DEFAULT'),
  mentions: MessageMentionsSchema,
  edited: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  // Default to [] so clients on older API builds don't break — this
  // keeps the schema forwards-compatible during gradual rollout.
  reactions: z.array(ReactionSummarySchema).default([]),
  // task-014-B: null for replies (thread panel context) OR root messages
  // that haven't been replied to yet — the UI branches on presence+count.
  parentMessageId: z.string().uuid().nullable().default(null),
  thread: ThreadSummarySchema.nullable().default(null),
  // Inline attachments per message (IMAGE / VIDEO / FILE). Default `[]`
  // for older API builds and for messages that were sent without an
  // attachment batch.
  attachments: z.array(AttachmentLiteSchema).default([]),
  // task-044-iter2: pinned message marker. `null` when 미고정.
  // `pinnedBy` 는 OWNER/ADMIN 의 userId — author 와 다를 수 있다.
  pinnedAt: z.string().datetime().nullable().default(null),
  pinnedBy: z.string().uuid().nullable().default(null),
  // S05 (FR-MSG-06): 낙관적 잠금 버전. 편집 시 +1 됩니다. 클라이언트는
  // 편집창 오픈 시 이 값을 스냅샷해 PATCH 의 expectedVersion 으로 보내고,
  // 서버는 version 불일치 시 409 + 현재 DTO 를 반환합니다. default(0) 라
  // 구 API 빌드 응답(version 누락)도 forward-compat 합니다.
  // 상한은 Postgres INT4 최대값(2,147,483,647) — DB 컬럼이 Int 라 초과 시
  // 쿼리 단계에서 numeric overflow(500) 가 나므로 계약 레벨에서 막습니다.
  version: z.number().int().nonnegative().max(2_147_483_647).default(0),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

// task-044-iter2: pinned messages — Discord-parity cap 50/channel.
export const MESSAGE_PIN_CAP = 50;

export const PinMessageResponseSchema = z.object({
  id: z.string().uuid(),
  pinnedAt: z.string().datetime(),
  pinnedBy: z.string().uuid(),
});
export type PinMessageResponse = z.infer<typeof PinMessageResponseSchema>;

export const ListPinsResponseSchema = z.object({
  items: z.array(MessageDtoSchema),
  cap: z.number().int().positive(),
  used: z.number().int().nonnegative(),
});
export type ListPinsResponse = z.infer<typeof ListPinsResponseSchema>;

// POST /messages/:id/reactions + DELETE counterpart — simple enough we
// reuse the ReactionSummary shape on the response.
export const AddReactionRequestSchema = z.object({
  emoji: z.string().min(1).max(64),
});
export type AddReactionRequest = z.infer<typeof AddReactionRequestSchema>;

export const SendMessageRequestSchema = z.object({
  content: MessageContentSchema,
  // S03 (FR-MSG-04): clientNonce — a UUID v4 the client generates ONCE per
  // logical send. It is echoed back on the `message:created` WS event so the
  // sending tab can swap its optimistic (pending) row for the confirmed one.
  // The SAME value is sent in the `Idempotency-Key` header for server-side
  // dedupe; the client never mints a separate tempId (single-identifier
  // contract, D17). Optional so older clients / system callers still work.
  nonce: z.string().uuid().optional(),
  // task-014-B: optional reply target. Server validates that the parent
  // exists, lives in the same channel, and is itself a root message
  // (single-level depth — parent.parentMessageId must be null).
  parentMessageId: z.string().uuid().optional(),
  // Previously-uploaded attachments to link to this message. Each id
  // must reference a finalized Attachment row for the same channel
  // that the uploader still owns; the server rejects mismatches.
  // Cap 10 per message matches the DS attachment grid's max visible
  // count — large galleries belong in a separate upload batch.
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  // S21 (FR-RS-16): composer 가 멘션 피커로 선택한 특수멘션 의도(@everyone /
  // @here / @channel). 서버는 user/channel 멘션을 본문 텍스트에서 권위적으로
  // 재추출하지만, 특수멘션은 본문에 sigil 이 없을 수도 있어(피커 선택만) 클라
  // 힌트를 OR 로 병합한 뒤 gate.ts 로 권한 게이트한다. 권한 없는 특수멘션은
  // 저장 시 false 로 다운그레이드되므로 신뢰 경계는 유지된다.
  mentions: z
    .object({
      everyone: z.boolean().optional(),
      here: z.boolean().optional(),
      channel: z.boolean().optional(),
    })
    .optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const UpdateMessageRequestSchema = z.object({
  content: MessageContentSchema,
  // S05 (FR-MSG-06): 낙관적 잠금. 편집창 오픈 시점의 MessageDto.version
  // 스냅샷을 항상 동봉합니다. 서버 측 version 과 불일치하면 409 +
  // MESSAGE_VERSION_CONFLICT (현재 MessageDto 포함) 로 거부합니다.
  // 상한 = Postgres INT4 max. 초과값은 WHERE version=:expected 바인딩 시
  // overflow(500) 를 유발하므로 계약에서 차단합니다.
  expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
});
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;

// ── S05 (FR-MSG-06 / FR-RC16): 메시지 편집 이력 ────────────────────────────
// 편집 시 직전 본문 스냅샷을 MessageEditHistory 에 적재합니다. 작성자 본인
// 또는 MANAGE_MESSAGES 권한자만 GET .../:msgId/history 로 최대 10개(ring
// buffer)까지 조회할 수 있습니다(일반 멤버는 403). FR-MSG-08 의 이력
// 팝오버 UI 는 S06 에서 이 계약을 소비합니다.
export const EDIT_HISTORY_CAP = 10;

export const EditHistoryDtoSchema = z.object({
  // 스냅샷 당시(편집 전) 메시지 version.
  version: z.number().int().nonnegative(),
  contentRaw: z.string().nullable(),
  contentAst: RichTextRootSchema.nullable(),
  contentPlain: z.string(),
  // 스냅샷 생성(=해당 편집 발생) 시각.
  editedAt: z.string().datetime(),
});
export type EditHistoryDto = z.infer<typeof EditHistoryDtoSchema>;

export const ListEditHistoryResponseSchema = z.object({
  // version desc (최신 편집 먼저), 최대 EDIT_HISTORY_CAP 개.
  items: z.array(EditHistoryDtoSchema).max(EDIT_HISTORY_CAP),
});
export type ListEditHistoryResponse = z.infer<typeof ListEditHistoryResponseSchema>;

export const ListMessagesQuerySchema = z
  .object({
    before: CursorStringSchema.optional(),
    after: CursorStringSchema.optional(),
    around: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    includeDeleted: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((v) => v === true || v === 'true'),
    // S03 (FR-MSG-21 edge case): `lastReadMessageId` is a READ-STATE cursor,
    // NOT a pagination cursor. The pagination contract uses opaque
    // base64url(JSON{id,createdAt}) tokens only. Accepting `lastReadMessageId`
    // here lets us reject it explicitly (400) instead of silently ignoring
    // it — mixing the two cursor namespaces is a client bug we surface loudly.
    lastReadMessageId: z.string().optional(),
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, {
    message: 'before / after / around are mutually exclusive',
  })
  .refine((q) => q.lastReadMessageId === undefined, {
    message:
      'lastReadMessageId must not be used as a pagination cursor — use the opaque before/after token',
    path: ['lastReadMessageId'],
  });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const PageInfoSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: CursorStringSchema.nullable(),
  prevCursor: CursorStringSchema.nullable(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export const ListMessagesResponseSchema = z.object({
  items: z.array(MessageDtoSchema),
  pageInfo: PageInfoSchema,
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

// Task-014-B: GET /messages/:id/thread returns this. Replies sorted ASC
// (oldest first) for the side panel — opposite of the main channel list.
export const ListThreadRepliesQuerySchema = z.object({
  cursor: CursorStringSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListThreadRepliesQuery = z.infer<typeof ListThreadRepliesQuerySchema>;

export const ListThreadRepliesResponseSchema = z.object({
  root: MessageDtoSchema,
  replies: z.array(MessageDtoSchema),
  pageInfo: PageInfoSchema,
});
export type ListThreadRepliesResponse = z.infer<typeof ListThreadRepliesResponseSchema>;

// Task-015-B: message full-text search. Snippet carries `<mark>` HTML
// from Postgres ts_headline; frontends must sanitize with DOMPurify.
export const SearchResultSchema = z.object({
  messageId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  senderId: z.string().uuid(),
  senderName: z.string(),
  createdAt: z.string().datetime(),
  snippet: z.string(),
  rank: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  nextCursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// S29 (FR-S08): 검색 정렬 모드. relevance(ts_rank_cd, 기본) | recent(createdAt DESC).
export const SearchSortSchema = z.enum(['relevance', 'recent']);
export type SearchSort = z.infer<typeof SearchSortSchema>;

// S29 (FR-S05): 검색 수식어(클라이언트 문서용). 쿼리 문자열 안에 인라인으로
// 작성한다 — `from:@user in:#channel has:link|image|file before:YYYY-MM-DD
// after:YYYY-MM-DD during:today|yesterday|week|month|YYYY-MM is:pinned`.
// 서버 파서(search-query.parser)가 권위적 해석을 수행하므로 이 상수는
// UI 힌트/자동완성용 enum 일 뿐이다.
export const SEARCH_HAS_TYPES = ['link', 'image', 'file'] as const;
export type SearchHasType = (typeof SEARCH_HAS_TYPES)[number];
