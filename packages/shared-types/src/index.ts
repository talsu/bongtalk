import { z } from 'zod';

export const UuidSchema = z.string().uuid();

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  username: z.string().min(2).max(32),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const WorkspaceSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(64),
  slug: z.string().min(2).max(64),
  ownerId: UuidSchema,
  createdAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// Channel/ChannelType schemas were moved to `./channel.ts` in task-003 and
// are re-exported at the bottom of this file.

export const MessageSchema = z.object({
  id: UuidSchema,
  channelId: UuidSchema,
  authorId: UuidSchema,
  content: z.string().min(1).max(4000),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptime: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    db: z.boolean(),
    redis: z.boolean(),
  }),
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
  'INVITE_NOT_FOUND',
  'INVITE_EXPIRED',
  'INVITE_EXHAUSTED',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NAME_TAKEN',
  'CHANNEL_NAME_INVALID',
  'CHANNEL_TYPE_NOT_IMPLEMENTED',
  'CHANNEL_PURGED',
  'CHANNEL_POSITION_INVALID',
  'CHANNEL_ARCHIVED',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_NAME_TAKEN',
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
