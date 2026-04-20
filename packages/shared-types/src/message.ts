import { z } from 'zod';

export const MESSAGE_MAX_LENGTH = 4000;

export const MessageContentSchema = z.string().min(1).max(MESSAGE_MAX_LENGTH);

export const MessageMentionsSchema = z.object({
  users: z.array(z.string().uuid()),
  channels: z.array(z.string().uuid()),
  everyone: z.boolean(),
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

export const MessageDtoSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  content: MessageContentSchema.nullable(),
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
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

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
