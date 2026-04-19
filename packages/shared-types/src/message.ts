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
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

export const SendMessageRequestSchema = z.object({
  content: MessageContentSchema,
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
