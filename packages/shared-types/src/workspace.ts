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

// task-030: Workspace discovery
export const WorkspaceVisibilitySchema = z.enum(['PUBLIC', 'PRIVATE']);
export type WorkspaceVisibility = z.infer<typeof WorkspaceVisibilitySchema>;

export const WorkspaceCategorySchema = z.enum([
  'PROGRAMMING',
  'GAMING',
  'MUSIC',
  'ENTERTAINMENT',
  'SCIENCE',
  'TECH',
  'EDUCATION',
  'OTHER',
]);
export type WorkspaceCategory = z.infer<typeof WorkspaceCategorySchema>;

export const WORKSPACE_CATEGORY_META: Record<WorkspaceCategory, { label: string; icon: string }> = {
  PROGRAMMING: { label: '프로그래밍', icon: 'code' },
  GAMING: { label: '게이밍', icon: 'compass' },
  MUSIC: { label: '음악', icon: 'headphones' },
  ENTERTAINMENT: { label: '엔터테인먼트', icon: 'video' },
  SCIENCE: { label: '과학', icon: 'compass' },
  TECH: { label: '기술', icon: 'compass' },
  EDUCATION: { label: '교육', icon: 'bookmark' },
  OTHER: { label: '기타', icon: 'hash' },
};

export const CreateWorkspaceRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    slug: SlugSchema,
    description: z.string().max(500).optional(),
    iconUrl: z.string().url().max(512).optional(),
    visibility: WorkspaceVisibilitySchema.optional(),
    category: WorkspaceCategorySchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.visibility === 'PUBLIC') {
      if (!data.category) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['category'],
          message: 'category is required for PUBLIC workspaces',
        });
      }
      if (!data.description || data.description.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['description'],
          message: 'description is required for PUBLIC workspaces',
        });
      }
    }
  });
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  iconUrl: z.string().url().max(512).nullable().optional(),
  visibility: WorkspaceVisibilitySchema.optional(),
  category: WorkspaceCategorySchema.nullable().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: SlugSchema,
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  ownerId: z.string().uuid(),
  visibility: WorkspaceVisibilitySchema.default('PRIVATE'),
  category: WorkspaceCategorySchema.nullable(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  deleteAt: z.string().datetime().nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const DiscoveryWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: SlugSchema,
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  category: WorkspaceCategorySchema,
  memberCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime().nullable(),
});
export type DiscoveryWorkspace = z.infer<typeof DiscoveryWorkspaceSchema>;

export const DiscoveryPageSchema = z.object({
  items: z.array(DiscoveryWorkspaceSchema),
  nextCursor: z.string().nullable(),
});
export type DiscoveryPage = z.infer<typeof DiscoveryPageSchema>;

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
