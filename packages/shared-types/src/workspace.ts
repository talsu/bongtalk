import { z } from 'zod';

export const WorkspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

/** Ranked so that guard logic can compare role seniority numerically. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
};

/** Slugs that route conflicts or admin surfaces would reserve. Keep in sync with server. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'auth',
  'admin',
  'www',
  'app',
  'settings',
  'billing',
  'help',
  'support',
  'static',
  'assets',
  'public',
  'invites',
  'workspaces',
  'channels',
  'messages',
  'users',
  'me',
  'new',
]);

export const SlugSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'slug must be lowercase letters, digits, or hyphens');

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(64),
  slug: SlugSchema,
  description: z.string().max(280).optional(),
  iconUrl: z.string().url().max(512).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(280).nullable().optional(),
  iconUrl: z.string().url().max(512).nullable().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: SlugSchema,
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  ownerId: z.string().uuid(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  deleteAt: z.string().datetime().nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceWithMyRoleSchema = WorkspaceSchema.extend({
  myRole: WorkspaceRoleSchema,
});
export type WorkspaceWithMyRole = z.infer<typeof WorkspaceWithMyRoleSchema>;

export const MemberSchema = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: WorkspaceRoleSchema,
  joinedAt: z.string().datetime(),
  user: z.object({
    id: z.string().uuid(),
    username: z.string(),
    email: z.string().email(),
  }),
});
export type Member = z.infer<typeof MemberSchema>;

export const UpdateRoleRequestSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER']), // OWNER is not directly assignable; use transfer-ownership
});
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;

export const TransferOwnershipRequestSchema = z.object({
  toUserId: z.string().uuid(),
});
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequestSchema>;

export const CreateInviteRequestSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().positive().max(10_000).optional(),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

export const InviteSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  workspaceId: z.string().uuid(),
  createdById: z.string().uuid(),
  expiresAt: z.string().datetime().nullable(),
  maxUses: z.number().int().positive().nullable(),
  usedCount: z.number().int().nonnegative(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  url: z.string().url(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const InvitePreviewSchema = z.object({
  workspace: z.object({
    name: z.string(),
    slug: SlugSchema,
    iconUrl: z.string().nullable(),
  }),
  expiresAt: z.string().datetime().nullable(),
  usesRemaining: z.number().int().nullable(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;
