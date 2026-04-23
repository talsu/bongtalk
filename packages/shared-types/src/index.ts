import { z } from 'zod';

export const UuidSchema = z.string().uuid();

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  username: z.string().min(2).max(32),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

// task-031-A: Workspace + WorkspaceSchema are defined in ./workspace
// and re-exported via `export * from './workspace'` below. The previous
// duplicate here shadowed the richer schema (visibility + category
// were missing from the type that 030 added).

// Channel/ChannelType schemas were moved to `./channel.ts` in task-003 and
// are re-exported at the bottom of this file.

// Message schemas moved to `./message.ts` in task-004 — re-exported at EOF.

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptime: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    db: z.enum(['ok', 'fail']),
    redis: z.enum(['ok', 'fail']),
    // task-020-A: outbox reports three-state now — "ok" = healthy or
    // draining, "idle" = empty backlog + quiet dispatcher, "stalled"
    // = backlog + no tick. Frontend health pages + smoke scripts can
    // branch on all three.
    outbox: z.enum(['ok', 'idle', 'stalled']),
  }),
  details: z
    .object({
      outbox: z.string().optional(),
    })
    .optional(),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export const ErrorCodeSchema = z.enum([
  'AUTH_INVALID_TOKEN',
  'AUTH_EMAIL_TAKEN',
  'AUTH_USERNAME_TAKEN',
  'AUTH_WEAK_PASSWORD',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_ACCOUNT_LOCKED',
  'AUTH_SESSION_COMPROMISED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NOT_MEMBER',
  'WORKSPACE_SLUG_TAKEN',
  'WORKSPACE_SLUG_RESERVED',
  'WORKSPACE_INSUFFICIENT_ROLE',
  'WORKSPACE_CANNOT_DEMOTE_OWNER',
  'WORKSPACE_CANNOT_REMOVE_OWNER',
  'WORKSPACE_OWNER_MUST_TRANSFER',
  'WORKSPACE_TARGET_NOT_MEMBER',
  'WORKSPACE_ALREADY_MEMBER',
  'WORKSPACE_PURGED',
  'WORKSPACE_NOT_PUBLIC',
  'FRIEND_TARGET_NOT_FOUND',
  'FRIEND_CANNOT_SELF',
  'FRIEND_ALREADY',
  'FRIEND_BLOCKED',
  'FRIEND_REQUEST_DUPLICATE',
  'FRIEND_NOT_FOUND',
  'FRIEND_INVALID_STATE',
  'FRIEND_CAP_REACHED',
  'INVITE_NOT_FOUND',
  'INVITE_EXPIRED',
  'INVITE_EXHAUSTED',
  // task-015-A (014-follow-3 closure): these existed on the backend
  // enum + HTTP map but were missing from the shared schema, so the
  // web client could not safely branch on them. A unit regression
  // guard in `error-code-schema.unit.spec.ts` stops future drift.
  'INVITE_REVOKED',
  // task-016-C-2: closed-beta gate on POST /auth/signup when
  // BETA_INVITE_REQUIRED=true. Client maps this to a support-email
  // link instead of a retry-able error.
  'BETA_INVITE_REQUIRED',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NAME_TAKEN',
  'CHANNEL_NAME_INVALID',
  'CHANNEL_TYPE_NOT_IMPLEMENTED',
  'CHANNEL_PURGED',
  'CHANNEL_POSITION_INVALID',
  'CHANNEL_ARCHIVED',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_NAME_TAKEN',
  'MESSAGE_NOT_FOUND',
  'MESSAGE_CONTENT_INVALID',
  'MESSAGE_CURSOR_INVALID',
  'MESSAGE_NOT_AUTHOR',
  'MESSAGE_THREAD_DEPTH_EXCEEDED',
  'MESSAGE_PARENT_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSE_CONFLICT',
  // task-015-A (014-follow-3 closure): attachments + channel
  // visibility + generic forbidden codes. All existed in the backend
  // enum from task-012; schema drift hid them from the client.
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENT_MIME_REJECTED',
  'ATTACHMENT_NOT_UPLOADED',
  'ATTACHMENT_SIZE_MISMATCH',
  'CHANNEL_NOT_VISIBLE',
  // task-037-D custom emoji
  'CUSTOM_EMOJI_NOT_FOUND',
  'CUSTOM_EMOJI_NAME_TAKEN',
  'CUSTOM_EMOJI_NAME_INVALID',
  'CUSTOM_EMOJI_CAP_REACHED',
  'CUSTOM_EMOJI_MIME_REJECTED',
  'CUSTOM_EMOJI_TOO_LARGE',
  // task-038-B magic-byte validation
  'INVALID_MAGIC_BYTES',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  errorCode: ErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
  retryAfterSec: z.number().int().positive().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export * from './auth';
export * from './workspace';
export * from './channel';
export * from './message';
export * from './presence';
export * from './notifications';
