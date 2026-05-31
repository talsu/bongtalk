import { z } from 'zod';
import { Cuid2Schema } from './mrkdwn';
import { RichTextRootSchema } from './mrkdwn-ast';

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
});
export type MessageMentions = z.infer<typeof MessageMentionsSchema>;

// Opaque cursor: base64url(JSON.stringify({ t, id })). The UI must treat the
// string as an opaque token — decoding is server-side.
export const CursorStringSchema = z.string().min(1).max(512);
export const CursorPayloadSchema = z.object({
  t: z.string().datetime(),
  id: z.string().uuid(),
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
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const UpdateMessageRequestSchema = z.object({
  content: MessageContentSchema,
});
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;

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
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, {
    message: 'before / after / around are mutually exclusive',
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
