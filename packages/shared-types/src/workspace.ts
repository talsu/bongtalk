import { z } from 'zod';

// S61 (D12 / FR-RM01): 시스템 역할 계층을 3단계 → 5단계로 확장합니다
// (OWNER > ADMIN > MODERATOR > MEMBER > GUEST). MODERATOR/GUEST 는 Prisma
// WorkspaceRole enum 에도 신규 추가되며, 기존 row 는 backfill 영향 없습니다
// (OWNER/ADMIN/MEMBER 값은 그대로 유지).
export const WorkspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

/**
 * Ranked so that guard logic can compare role seniority numerically.
 * S61: 5단계로 확장. 값 자체는 비교에만 쓰이며 position(역할 서열)과는 별개다
 * — position 은 Role 테이블의 정수 컬럼이고, 이 RANK 는 시스템 role guard 의
 * 최소 등급 비교(@Roles(MIN))용 상수다.
 */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  OWNER: 5,
  ADMIN: 4,
  MODERATOR: 3,
  MEMBER: 2,
  GUEST: 1,
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
    customStatus: z.string().nullable().optional(),
    // S28 (HIGH-2 + FR-P17): 멤버목록 emoji 노출. customStatus(text) 와 함께
    // 만료(customStatusExpiresAt<now) 마스킹 대상이다 — 만료분은 text/emoji 모두 null.
    customStatusEmoji: z.string().nullable().optional(),
    // S28 (FR-P17): 만료 시각(ISO UTC). 클라가 만료 카운트다운/안내 표시에 사용.
    // 서버는 노출 시점에 만료분을 이미 마스킹하므로 여기 값은 항상 미래이거나 null.
    customStatusExpiresAt: z.string().nullable().optional(),
  }),
});
export type Member = z.infer<typeof MemberSchema>;

// ── S27 (FR-P08/P09/P11/P12): grouped member list ──────────────────────────

/**
 * S27 (FR-P08): runtime presence status group buckets. Mirrors the four
 * observable PresenceStatus values (invisible is masked → offline for others
 * before bucketing, so it never appears as its own group). `dnd` outranks
 * `idle` which outranks `online` only for the dot; the GROUP itself follows
 * online → idle → dnd → offline for display order.
 */
export const MemberStatusGroupSchema = z.enum(['online', 'idle', 'dnd', 'offline']);
export type MemberStatusGroup = z.infer<typeof MemberStatusGroupSchema>;

/**
 * S27 (FR-P08): one member row inside a group. Extends the base Member with the
 * viewer-masked presence status and (offline only) lastSeenAt. lastSeenAt is
 * intentionally null for non-offline rows AND for invisible-masked-to-offline
 * rows (FR-P10 leak guard — see members.service).
 *
 * S27 fix-forward(security · FR-P10): lastSeenAt 는 **일 단위(UTC 자정)** 로
 * 둔감화된 ISO 문자열이다. 서버가 raw 밀리초 대신 day-granularity 로 내려보내
 * 활동패턴(분/초 단위 접속시각) 추적을 막는다. UI 는 "오늘/어제/N일 전" 으로
 * 표시한다.
 */
export const MemberWithPresenceSchema = MemberSchema.extend({
  status: MemberStatusGroupSchema,
  lastSeenAt: z.string().datetime().nullable(),
  /**
   * S63 (FR-RM07): 모더레이션 타임아웃 만료 시각(ISO UTC) 또는 null. 서버가 lazy
   * 체크로 만료분(mutedUntil<=now)을 null 로 마스킹해 내려보내므로, 비-null 이면
   * 항상 미래의 활성 음소거다. FE 는 이 값으로 멤버 목록에 음소거 배지를 그린다.
   */
  mutedUntil: z.string().datetime().nullable().optional(),
});
export type MemberWithPresence = z.infer<typeof MemberWithPresenceSchema>;

/**
 * S27 (FR-P09): hoisted role group. qufox has no custom-role system yet
 * (WorkspaceRole enum only), so OWNER/ADMIN are the baseline hoist set —
 * surfaced as a single "운영진" (staff) group above the status groups. Custom
 * per-role hoist (hoistInMemberList column) is a carryover pending the role
 * system.
 */
export const HoistGroupSchema = z.object({
  /** stable group key — `staff` for the OWNER/ADMIN baseline. */
  key: z.literal('staff'),
  label: z.string(),
  members: z.array(MemberWithPresenceSchema),
});
export type HoistGroup = z.infer<typeof HoistGroupSchema>;

export const StatusGroupSchema = z.object({
  key: MemberStatusGroupSchema,
  label: z.string(),
  members: z.array(MemberWithPresenceSchema),
});
export type StatusGroup = z.infer<typeof StatusGroupSchema>;

export const ListMembersResponseSchema = z.object({
  /** FR-P09: hoisted OWNER/ADMIN, online-first within the group. */
  hoist: z.array(HoistGroupSchema),
  /** FR-P08: status-bucketed remaining members (online/idle/dnd/offline). */
  groups: z.array(StatusGroupSchema),
  /** FR-P12: cursor for the next page (opaque joinedAt|userId), null at end. */
  nextCursor: z.string().nullable(),
  /**
   * FR-P11: whether the OFFLINE group is present in this response. Large
   * workspaces (>= LARGE_WORKSPACE_THRESHOLD members) drop OFFLINE by default;
   * a client can re-request with include_offline=true to override.
   */
  includeOffline: z.boolean(),
});
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;

/** S27 (FR-P12): member-list page size. */
export const MEMBER_LIST_PAGE_SIZE = 50;

/**
 * S27 fix-forward(security): opaque member-list cursor 길이 상한. cursor 는
 * base64url(`<joinedAtISO>|<userId>`) 라 정상값은 ~60자 미만이다. 컨트롤러가
 * 이 값을 넘는 cursor 를 거부(VALIDATION_FAILED)해 비대한/악의적 입력이 디코드
 * 경로로 흘러드는 것을 막는다.
 */
export const MEMBER_CURSOR_MAX_LENGTH = 256;

/**
 * S27 (FR-P11): workspaces with at least this many members omit the OFFLINE
 * group by default (presence fan-out + member-list both stay online-scoped).
 */
export const LARGE_WORKSPACE_THRESHOLD = 1000;

/**
 * S27 (FR-P09): roles surfaced in the baseline hoist group. Until a custom
 * role system exists, OWNER + ADMIN are the staff hoist set.
 */
export const HOISTED_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(['OWNER', 'ADMIN']);

/** S27 (FR-P09): true iff this role is hoisted into the staff group. */
export function isHoistedRole(role: WorkspaceRole): boolean {
  return HOISTED_ROLES.has(role);
}

// S61: 커스텀 Role 의 UpdateRoleRequestSchema(roles.ts) 와 이름 충돌을 피하려
// 멤버 시스템 역할 변경 바디는 UpdateMemberRoleRequestSchema 로 명명한다.
// MODERATOR/GUEST 도 직접 배정 가능(OWNER 는 transfer-ownership 전용).
export const UpdateMemberRoleRequestSchema = z.object({
  role: z.enum(['ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']),
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

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
