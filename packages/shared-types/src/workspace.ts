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
  // S65 fix-forward (security A-3): 헬스/관측/스토리지 surface 와의 라우트 충돌을
  // 막기 위해 운영용 경로 토큰을 예약 목록에 추가한다(slug 가 이 값을 점유하면
  // /healthz 같은 인프라 라우트나 download/upload/media 게이트와 충돌할 수 있다).
  'health',
  'healthz',
  'readyz',
  'metrics',
  'internal',
  'download',
  'upload',
  'media',
]);

export const SlugSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'slug must be lowercase letters, digits, or hyphens');

// task-030: Workspace discovery
export const WorkspaceVisibilitySchema = z.enum(['PUBLIC', 'PRIVATE']);
export type WorkspaceVisibility = z.infer<typeof WorkspaceVisibilitySchema>;

// S65 (D13 / FR-W01): 워크스페이스 가입 방식. visibility(discover 노출 여부)와
// 직교한다 — joinMode 는 "어떻게 들어오는가"(초대/즉시/신청), visibility 는 "찾기에
// 보이는가". APPLY 신청 플로우(FR-W06)는 S66+ carryover 로, S65 는 생성 시 모드
// 설정만 다룬다.
export const WorkspaceJoinModeSchema = z.enum(['PRIVATE', 'PUBLIC', 'APPLY']);
export type WorkspaceJoinMode = z.infer<typeof WorkspaceJoinModeSchema>;

// S65 (D13 / FR-W01): 이메일 도메인 화이트리스트 1건의 형태(예: "example.com").
// 도메인 형태만 허용한다. 빈 배열 = 제한 없음. 전체 상한 32건.
//
// S68 fix-forward (security LOW-3): 입력 대문자 도메인(`Acme.COM`)을 400 으로 튕기지 않고
// 먼저 소문자로 정규화한 뒤 호스트 형태를 검증한다. 도메인은 대소문자 비구분이므로 사용자가
// 대문자로 입력해도 마찰 없이 받아들이고, 서버 저장값은 항상 소문자 단일 형태가 된다.
export const EmailDomainSchema = z
  .string()
  .min(3)
  .max(255)
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
        'email domain must be a host like example.com',
      ),
  );

export const EMAIL_DOMAINS_MAX = 32;

// S68 fix-forward (reviewer MN2 / security MEDIUM-2): 다중 레이블(TLD 수준) 도메인 경고
// 판별을 FE(EmailDomainsPanel)·BE(pending-invite-tokens) 양쪽에서 중복 정의하던 것을
// shared-types 단일 출처로 끌어올린다(contract 원칙 — 한쪽만 고쳐 드리프트하는 일 방지).
//
// `co.uk`/`com` 같은 너무 넓은 입력은 워크스페이스를 사실상 개방하므로 UI 가 경고 배너를
// 띄울 수 있게 판별만 한다(정규식 제한은 하지 않음 — 안내용). 휴리스틱: 레이블 2개 이하
// 또는 알려진 2단계 public-suffix.
export const TWO_LEVEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'co.kr',
  'co.jp',
  'com.au',
  'com.br',
  'co.nz',
  'or.kr',
  'ne.jp',
  'co.in',
  'com.cn',
]);

export function isOverlyBroadDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (d.length === 0) return false;
  const labels = d.split('.');
  if (labels.length <= 2) return true;
  // 마지막 두 레이블이 알려진 2단계 public-suffix 면(예: example.co.uk 의 co.uk) 자체는
  // 정상이지만, 입력값이 그 public-suffix 자체(`co.uk`)면 너무 넓다.
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(d)) return true;
  return false;
}

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
    // S65 (D13 / FR-W01): 가입 방식(미지정 시 서버 기본 PRIVATE). emailDomains 는
    // 화이트리스트(빈 배열/미지정 = 제한 없음). visibility 와 직교하므로 PUBLIC
    // 검증(category/description)에는 영향을 주지 않는다.
    joinMode: WorkspaceJoinModeSchema.optional(),
    emailDomains: z.array(EmailDomainSchema).max(EMAIL_DOMAINS_MAX).optional(),
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
  // 072 백로그 S-C 리뷰(LOW): iconUrl 은 PATCH 에서 제거했다. 아이콘 변경은 전용 엔드포인트
  // (POST /icon/presign · PUT /icon · DELETE /icon)가 단일 출처다. iconUrl 컬럼은 이제 MinIO
  // storageKey 를 담는데(presign-on-read 변환), z.string().url() PATCH 는 외부 절대 URL 만
  // 받아 storageKey 모델과 충돌하고 finalize-설정 키를 덮으며 orphan 객체를 남겼다.
  visibility: WorkspaceVisibilitySchema.optional(),
  // 072 백로그 S-C (FR-W01): 가입 모드 편집(생성 모달엔 이미 있던 필드를 설정에도 노출).
  // OWNER 게이트는 서비스 레이어(visibility/category 선례). joinMode 와 visibility 는 직교.
  joinMode: WorkspaceJoinModeSchema.optional(),
  category: WorkspaceCategorySchema.nullable().optional(),
  // S68 (D13 / FR-W05 · Fork C): 이메일 도메인 화이트리스트 관리. 전용 엔드포인트 없이
  // 기존 PATCH /workspaces/:id 로 확장한다. OWNER 전용 게이트는 서비스 레이어가 강제하며
  // (visibility/category OWNER 게이트 선례 일관), 서버가 소문자 정규화 + 중복 제거해
  // 저장한다. 빈 배열 = 제한 없음. 미지정(undefined)이면 변경 없음.
  emailDomains: z.array(EmailDomainSchema).max(EMAIL_DOMAINS_MAX).optional(),
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
  // S65 (D13 / FR-W01·W19): 가입 방식·이메일 도메인 화이트리스트·기본 채널. forward-
  // compat 를 위해 optional/default 로 두어 기존 응답 소비자(없는 필드)도 안전하다.
  joinMode: WorkspaceJoinModeSchema.default('PRIVATE'),
  emailDomains: z.array(z.string()).default([]),
  defaultChannelId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  deleteAt: z.string().datetime().nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// S65 (D13 / FR-W19): 기본 채널 변경 요청. OWNER 전용·대상은 공개 채널이어야 한다
// (서버 검증). 별도 엔드포인트 PATCH /workspaces/:id/default-channel 의 바디.
export const UpdateDefaultChannelRequestSchema = z.object({
  defaultChannelId: z.string().uuid(),
});
export type UpdateDefaultChannelRequest = z.infer<typeof UpdateDefaultChannelRequestSchema>;

// S72 (D13 / FR-W15): 워크스페이스 삭제 요청. OWNER 전용이며, 오삭제를 막기 위해
// body.confirmation 에 워크스페이스 slug 를 그대로 타이핑하도록 강제한다(GitHub repo
// 삭제 / 채널 비공개→공개 전환 confirmName 선례). 서버가 confirmation !== workspace.slug
// 면 422(WORKSPACE_CONFIRMATION_MISMATCH)로 거부하고, 일치하면 기존 softDelete 흐름
// (deletedAt/deleteAt 기록 + 30일 grace + outbox WORKSPACE_DELETED)으로 진입한다.
// confirmation 은 비어 있을 수 있으나(빈 slug 는 SlugSchema 상 불가) 형태 검증은 string
// 만 한다 — slug 대조는 서버가 실제 워크스페이스 slug 로 한다(클라가 위조해도 무의미).
export const DeleteWorkspaceRequestSchema = z.object({
  confirmation: z.string(),
});
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;

// S72 (D13 / FR-W15): 삭제 성공(202) 응답. 클라가 "N일 후 영구 삭제" 안내 + 복원 진입점
// 노출에 쓰는 grace 종료 시각(ISO UTC)을 싣는다(softDelete 가 계산한 deleteAt).
export const DeleteWorkspaceResponseSchema = z.object({
  deleteAt: z.string().datetime(),
});
export type DeleteWorkspaceResponse = z.infer<typeof DeleteWorkspaceResponseSchema>;

export const DiscoveryWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: SlugSchema,
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  category: WorkspaceCategorySchema,
  // S72 (D13 / FR-W16): 가입 방식 노출 — FE 카드 CTA 가 PUBLIC=참가 / APPLY=신청 /
  // PRIVATE=초대 필요로 분기한다. forward-compat 를 위해 default('PUBLIC') 로 둔다(구
  // 캐시 payload 에 필드가 없어도 안전 — discover 는 visibility=PUBLIC 만 노출하므로
  // 가장 흔한 가입 방식인 PUBLIC 을 기본값으로 둔다).
  joinMode: WorkspaceJoinModeSchema.default('PUBLIC'),
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
    // S74 (FR-PS-06 + S73 carryover): 표시 우선순위 전파. 멤버목록/채팅 작성자 표시는
    // resolveMemberDisplayName/resolveMemberAvatarUrl(아래 헬퍼)로 ws 오버라이드 >
    // 전역 displayName/avatarUrl > handle/username 순으로 해석한다. 서버가 LEFT JOIN 으로
    // 함께 내려보낸다(미설정 시 null — 폴백).
    displayName: z.string().nullable().optional(),
    // 전역 아바타 presigned GET URL(null = 미설정).
    avatarUrl: z.string().nullable().optional(),
    // 이 워크스페이스 오버라이드 닉네임(null = 미설정 → displayName 폴백).
    wsNickname: z.string().nullable().optional(),
    // 이 워크스페이스 오버라이드 아바타 presigned GET URL(null = 미설정 → avatarUrl 폴백).
    wsAvatarUrl: z.string().nullable().optional(),
  }),
});
export type Member = z.infer<typeof MemberSchema>;

/**
 * S74 (FR-PS-06 + S73 carryover): 멤버 표시명 우선순위 해석.
 *   ws nickname > 전역 displayName > handle/username
 * (handle 은 멤버목록 user 객체에 없으므로 username 으로 폴백 — handle 은 username 의
 *  소문자 정규화 버전이라 표시명 폴백으로는 username 이 적절하다.)
 */
export function resolveMemberDisplayName(user: {
  username: string;
  displayName?: string | null;
  wsNickname?: string | null;
}): string {
  return user.wsNickname ?? user.displayName ?? user.username;
}

/**
 * S74 (FR-PS-06 + S73 carryover): 멤버 아바타 URL 우선순위 해석.
 *   ws avatarUrl > 전역 avatarUrl > null(기본 이니셜 아바타로 폴백)
 */
export function resolveMemberAvatarUrl(user: {
  avatarUrl?: string | null;
  wsAvatarUrl?: string | null;
}): string | null {
  return user.wsAvatarUrl ?? user.avatarUrl ?? null;
}

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
 * FR-P09 (task-068 · S95): hoisted role group. 역할기반 hoistInMemberList 컬럼이
 * true 인 역할마다 별도 그룹을 만든다(Discord per-role hoist). 종전 S27 은 커스텀 Role
 * 부재로 OWNER/ADMIN 을 단일 '운영진'(staff) 그룹으로 하드코딩했으나, S61 커스텀 Role 로
 * 차단이 해소되어 역할기반 동적 hoist 로 전환했다(key 가 'staff' 리터럴 → roleId).
 * 그룹은 position DESC 정렬되고, 각 멤버는 보유한 hoisted 역할 중 최상위(position 최대)
 * 1개 그룹에만 들어간다(다중 hoisted 역할 dedup). 온라인 멤버만 hoist 된다(FR-P09 —
 * offline hoisted 멤버는 offline status 그룹으로 강등).
 */
export const HoistGroupSchema = z.object({
  /** stable group key = hoisted role id(React key · per-role 그룹 식별). */
  key: z.string(),
  /** 역할명(그룹 헤더 라벨). */
  label: z.string(),
  /**
   * FR-P09: 역할 색(#RRGGBB) 또는 null. FE 가 그룹 헤더에 틴트로 쓸 수 있다(optional —
   * 색상 미설정 역할은 생략/기본색).
   */
  color: z.string().nullable().optional(),
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
  /** FR-P09: per-role hoisted groups(hoistInMemberList=true), position DESC, online-first 내부 정렬. */
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

// ─────────────────────── S69 (D13 / FR-W10) 멤버 디렉터리 ────────────────────

/** S69 (FR-W10): 디렉터리 한 페이지 항목 수(커서 페이지네이션). */
export const MEMBER_DIRECTORY_PAGE_SIZE = 50;

/** S69 (FR-W10): 디렉터리 검색어 최대 길이(prefix 검색 — username/email). */
export const MEMBER_DIRECTORY_QUERY_MAX = 64;

/** S69 (FR-W10): 가입일 정렬 방향. asc=오래된 멤버 먼저, desc=최근 가입 먼저(기본). */
export const MemberDirectorySortSchema = z.enum(['joined_asc', 'joined_desc']);
export type MemberDirectorySort = z.infer<typeof MemberDirectorySortSchema>;

/**
 * S69 (FR-W10): 디렉터리 조회 쿼리. 모든 워크스페이스 멤버가 열람 가능(Fork C).
 *   - q:      username/email prefix(빈/미지정 → 전체).
 *   - role:   역할 정확 일치 필터(미지정 → 전체).
 *   - sortBy: 가입일 정렬(기본 joined_desc).
 *   - cursor: opaque base64url 다음 페이지 토큰.
 */
export const ListMemberDirectoryQuerySchema = z.object({
  q: z.string().trim().max(MEMBER_DIRECTORY_QUERY_MAX).optional(),
  role: WorkspaceRoleSchema.optional(),
  sortBy: MemberDirectorySortSchema.optional(),
  cursor: z.string().max(MEMBER_CURSOR_MAX_LENGTH).optional(),
});
export type ListMemberDirectoryQuery = z.infer<typeof ListMemberDirectoryQuerySchema>;

/**
 * S69 (FR-W10): 디렉터리 한 멤버 행. MemberWithPresence(역할/상태/가입일/음소거)에
 * 더해 **초대자(invitedById)** 와 그 표시 정보를 싣는다(프로필 클릭 시 노출). 기존 row 는
 * backfill 로 null 이며, joinPublic 가입도 null(초대자 없음).
 *
 * S69 fix-forward (security HIGH/BLOCKER · 이메일 노출 + enumeration): 디렉터리는 모든
 * 워크스페이스 멤버가 열람한다(Fork C). PII(email)·초대자(invitedBy/invitedById)는
 * **ADMIN+ 뷰어에게만** 노출하고, 비관리자(MEMBER/GUEST) 에게는 서버가 email=null +
 * invitedBy/invitedById=null 로 내려보낸다(FR-W10 프로필은 역할/상태/가입일/초대자라
 * 비관리자엔 email 불요). 따라서 디렉터리 행의 user.email 은 base Member(비-null email)
 * 와 달리 **nullable** 로 재정의한다(base MemberSchema/listGrouped 의 bulk email 노출은
 * broad-contract carryover — 여기서 건드리지 않는다). 비관리자에겐 q 가 username 만
 * 매칭하므로 email prefix enumeration 도 차단된다.
 */
export const MemberDirectoryRowSchema = MemberWithPresenceSchema.extend({
  /**
   * S69 fix-forward (security): user.email 을 nullable 로 재정의한다(ADMIN+ 만 노출,
   * 비관리자는 null). 다른 user 필드는 base MemberWithPresence 와 동일하다.
   */
  user: MemberWithPresenceSchema.shape.user.extend({
    email: z.string().email().nullable(),
  }),
  /** 이 멤버를 초대한 사용자 id(없으면 null — 공개 가입/레거시/비관리자 뷰어). */
  invitedById: z.string().uuid().nullable(),
  /** 초대자 표시 정보(계정 삭제·공개 가입 시, 또는 비관리자 뷰어에겐 null). */
  invitedBy: z
    .object({
      id: z.string().uuid(),
      username: z.string(),
    })
    .nullable(),
});
export type MemberDirectoryRow = z.infer<typeof MemberDirectoryRowSchema>;

/** S69 (FR-W10): 디렉터리 목록 응답. nextCursor null = 마지막 페이지. */
export const ListMemberDirectoryResponseSchema = z.object({
  members: z.array(MemberDirectoryRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListMemberDirectoryResponse = z.infer<typeof ListMemberDirectoryResponseSchema>;

// FR-P09 (task-068 · S95): 종전 S27 의 HOISTED_ROLES/isHoistedRole(OWNER/ADMIN
// 하드코딩 enum 집합)은 역할기반 Role.hoistInMemberList 컬럼으로 대체되어 제거했다.
// hoist 대상은 이제 워크스페이스별 Role.hoistInMemberList=true 행이 단일 출처다
// (시스템 역할 기본값은 roles.ts SYSTEM_ROLE_HOIST_DEFAULT — OWNER/ADMIN true).

// S61: 커스텀 Role 의 UpdateRoleRequestSchema(roles.ts) 와 이름 충돌을 피하려
// 멤버 시스템 역할 변경 바디는 UpdateMemberRoleRequestSchema 로 명명한다.
// MODERATOR/GUEST 도 직접 배정 가능(OWNER 는 transfer-ownership 전용).
export const UpdateMemberRoleRequestSchema = z.object({
  role: z.enum(['ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']),
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

// S65 (D13 / FR-W13): 소유권 양도는 OWNER 비밀번호 재확인을 강제한다(★결정 C).
// password 는 required — 하위호환을 위해 optional 로 두지 않는다(보안). 서버가
// argon2 PasswordService.verify 로 검증하며(저장된 passwordHash 는 argon2 —
// bcrypt.compare 는 불일치), 불일치 시 401(AUTH_INVALID_CREDENTIALS).
export const TransferOwnershipRequestSchema = z.object({
  toUserId: z.string().uuid(),
  password: z.string().min(1),
});
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequestSchema>;

export const CreateInviteRequestSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().positive().max(10_000).optional(),
  // S67 (D13 / FR-W02): 임시 멤버십 초대. 미지정 시 false(영구 멤버). 이 링크로 수락한
  // 멤버는 WorkspaceMember.isTemporary=true 로 기록된다(강퇴 배치는 S70 / FR-W12).
  temporary: z.boolean().optional().default(false),
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
  // S67 (D13 / FR-W02): 임시 멤버십 초대 여부.
  temporary: z.boolean().default(false),
  createdAt: z.string().datetime(),
  url: z.string().url(),
  // S67 (D13 / FR-W17): 관리 목록 표시용 파생 필드. usesRemaining 는 무제한(maxUses
  // null)이면 null, 아니면 max(0, maxUses-usedCount). active 는 미취소 + 미만료 +
  // 미소진. 서버 list() 가 계산해 내려보낸다(FE 가 재계산하지 않게).
  usesRemaining: z.number().int().nonnegative().nullable().optional(),
  active: z.boolean().optional(),
  // S67 (D13 / FR-W17): 생성자 표시(목록의 "생성자" 컬럼). best-effort 조인이며 없으면
  // 생략된다(FE 는 createdById 로 폴백).
  createdBy: z.object({ id: z.string().uuid(), username: z.string() }).nullable().optional(),
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

// S67 (D13 / FR-W03): 초대 수락 응답. 신규 가입(alreadyMember=false)과 이미 멤버였던
// 경우(alreadyMember=true · 멱등 200)를 한 shape 로 담는다. FE 는 두 경우 모두 workspace
// 로 이동하므로 alreadyMember 는 토스트 문구 분기용이다(throw 대신 멱등 성공).
export const AcceptInviteResponseSchema = z.object({
  workspace: WorkspaceSchema,
  alreadyMember: z.boolean(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;
