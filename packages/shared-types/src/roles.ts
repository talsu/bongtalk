import { z } from 'zod';
import { ALL_PERMISSIONS, PERMISSIONS, combine } from './permissions';

/**
 * S61 (D12 / FR-RM01·02): 커스텀 Role 시스템 단일 출처(shared-types).
 *
 * Role / MemberRole 의 Zod 스키마·DTO·시스템 역할 정의를 모읍니다. 권한 비트는
 * ADR-4 카탈로그(`permissions.ts`)를 재사용하며 여기서 재정의하지 않습니다
 * (FR-RM02). `permissions` 는 BigInt 비트필드이고 DTO 직렬화는 ADR-11 에 따라
 * string 으로 내려갑니다.
 */

/**
 * S61 (FR-RM01): 시스템 고정 5역할 키. WorkspaceRole enum 과 1:1 대응합니다.
 * position 은 높을수록 상위 — 시스템 역할의 권장 position 은 아래 표로 고정합니다
 * (커스텀 역할은 그 사이/위 임의 정수).
 */
export const SYSTEM_ROLE_NAMES = ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST'] as const;
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

/**
 * S61 (FR-RM01 / backfill 매핑): 시스템 역할의 기본 position. 높을수록 상위이며
 * 100 단위 간격으로 두어 커스텀 역할이 사이에 끼어들 여지를 둡니다. backfill
 * 마이그레이션이 동일 매핑을 사용합니다(WorkspaceMember.role → MemberRole).
 */
export const SYSTEM_ROLE_POSITION: Record<SystemRoleName, number> = {
  OWNER: 500,
  ADMIN: 400,
  MODERATOR: 300,
  MEMBER: 200,
  GUEST: 100,
};

/**
 * FR-P09 (task-068 · S95): 시스템 역할의 기본 hoistInMemberList 값. OWNER·ADMIN 만
 * true 라 종전 S27 의 '운영진'(staff) 단일 그룹 동작을 per-role 그룹으로 회귀 없이
 * 보존한다. backfill 마이그레이션과 신규 워크스페이스 시드(seedSystemRoles)가 이 매핑을
 * 단일 출처로 공유한다 — 두 경로의 동작이 항상 일치한다(기존/신규 워크스페이스 동형).
 */
export const SYSTEM_ROLE_HOIST_DEFAULT: Record<SystemRoleName, boolean> = {
  OWNER: true,
  ADMIN: true,
  MODERATOR: false,
  MEMBER: false,
  GUEST: false,
};

/**
 * S61 (FR-RM02): 시스템 역할의 기본 권한 비트(ADR-4 카탈로그 BigInt). 종전 집행
 * enum `ROLE_BASELINE`(OWNER/ADMIN/MEMBER) 를 BigInt 카탈로그로 대체합니다.
 *
 * - OWNER: ADMINISTRATOR(모든 권한 + 채널 overwrite 면제).
 * - ADMIN: 관리 비트 전반(채널/웹훅/초대/메시지 관리 + 슬로우모드 면제 + 멘션 +
 *   S63 모더레이션 KICK/BAN/TIMEOUT).
 * - MODERATOR: 메시지 관리 + 멘션 + 슬로우모드 면제 + S63 모더레이션
 *   KICK/BAN/TIMEOUT(채널/웹훅 관리는 제외).
 * - MEMBER: 일반 참여(조회·전송·열람·첨부·반응·슬래시·외부이모지).
 * - GUEST: 최소 참여(조회·전송·열람·반응) — 첨부/외부이모지/초대 불가.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleName, bigint> = {
  OWNER: PERMISSIONS.ADMINISTRATOR,
  ADMIN: combine(
    PERMISSIONS.VIEW_CHANNEL,
    PERMISSIONS.SEND_MESSAGES,
    PERMISSIONS.READ_HISTORY,
    PERMISSIONS.MANAGE_MESSAGES,
    PERMISSIONS.ATTACH_FILES,
    PERMISSIONS.ADD_REACTIONS,
    PERMISSIONS.USE_SLASH_COMMANDS,
    PERMISSIONS.MENTION_EVERYONE,
    PERMISSIONS.MANAGE_CHANNEL,
    PERMISSIONS.MANAGE_WEBHOOKS,
    PERMISSIONS.CREATE_INVITES,
    PERMISSIONS.USE_EXTERNAL_EMOJI,
    PERMISSIONS.BYPASS_SLOWMODE,
    // S63 (FR-RM05·06·07): MODERATOR+ 에 모더레이션 권한 기본 부여.
    PERMISSIONS.KICK_MEMBERS,
    PERMISSIONS.BAN_MEMBERS,
    PERMISSIONS.TIMEOUT_MEMBERS,
  ),
  MODERATOR: combine(
    PERMISSIONS.VIEW_CHANNEL,
    PERMISSIONS.SEND_MESSAGES,
    PERMISSIONS.READ_HISTORY,
    PERMISSIONS.MANAGE_MESSAGES,
    PERMISSIONS.ATTACH_FILES,
    PERMISSIONS.ADD_REACTIONS,
    PERMISSIONS.USE_SLASH_COMMANDS,
    PERMISSIONS.MENTION_EVERYONE,
    PERMISSIONS.CREATE_INVITES,
    PERMISSIONS.USE_EXTERNAL_EMOJI,
    PERMISSIONS.BYPASS_SLOWMODE,
    // S63 (FR-RM05·06·07): MODERATOR 도 모더레이션 권한 기본 보유.
    PERMISSIONS.KICK_MEMBERS,
    PERMISSIONS.BAN_MEMBERS,
    PERMISSIONS.TIMEOUT_MEMBERS,
  ),
  MEMBER: combine(
    PERMISSIONS.VIEW_CHANNEL,
    PERMISSIONS.SEND_MESSAGES,
    PERMISSIONS.READ_HISTORY,
    PERMISSIONS.ATTACH_FILES,
    PERMISSIONS.ADD_REACTIONS,
    PERMISSIONS.USE_SLASH_COMMANDS,
    PERMISSIONS.USE_EXTERNAL_EMOJI,
    PERMISSIONS.CREATE_INVITES,
  ),
  GUEST: combine(
    PERMISSIONS.VIEW_CHANNEL,
    PERMISSIONS.SEND_MESSAGES,
    PERMISSIONS.READ_HISTORY,
    PERMISSIONS.ADD_REACTIONS,
  ),
};

/** S61: #RRGGBB 색상 검증. null 은 "색상 없음"(기본 텍스트색). */
export const ColorHexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colorHex must be #RRGGBB');

/** S61: 역할 이름 — 1~64자, 공백 trim 후 비어있으면 거부. */
export const RoleNameSchema = z
  .string()
  .trim()
  .min(1, 'name must not be empty')
  .max(64, 'name must be at most 64 characters');

/**
 * S61 (ADR-11): permissions BigInt 는 응답에서 string 으로 직렬화됩니다. 요청에서도
 * string 으로 받아 서비스 레이어가 deserializePermissions 로 BigInt 변환합니다.
 *
 * S61 fix-forward (reviewer BLOCKER-3): 범위 밖 비트(ALL_PERMISSIONS 마스크 초과)는
 * 이 Zod 스키마에서 미리 거부합니다. 종전에는 deserializePermissions 의 RangeError 가
 * 서비스 레이어에서 처리되지 않아 500 으로 새어 나갔습니다. 이제 양의 정수 형식 +
 * ALL_PERMISSIONS 범위를 함께 검증해, 위반 시 컨트롤러 safeParse 가 422(VALIDATION_FAILED)
 * 로 매핑합니다. 음수/leading-zero/garbage 비트는 regex 에서, 미정의 비트는 refine 에서
 * 차단됩니다.
 */
export const PermissionsBitfieldSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'permissions must be a non-negative integer string')
  .refine((v) => (BigInt(v) & ~ALL_PERMISSIONS) === 0n, {
    message: 'permissions contains bits outside the defined permission catalog',
  });

/** S61 (FR-RM01): Role 응답 DTO. permissions 는 string(BigInt as string · ADR-11). */
export const RoleSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  colorHex: z.string().nullable(),
  position: z.number().int(),
  /** ADR-11: BigInt 비트필드를 string 으로 직렬화. */
  permissions: z.string(),
  isSystem: z.boolean(),
  /**
   * S88a (FR-MN-03 · D6): `@<RoleName>` 멘션 허용 여부. true 면 누구나 멘션 가능,
   * false 면 MENTION_EVERYONE 권한 보유자만 멘션할 수 있다(서버 게이트가 판정).
   * 비권한 메타라 시스템 역할도 토글 가능하다.
   */
  mentionable: z.boolean(),
  /**
   * FR-P09 (task-068 · S95): true 면 이 역할 멤버(온라인)가 멤버 목록 상단에 역할별
   * 별도 그룹으로 hoist 된다(Discord hoist). 비권한 메타라 시스템 역할도 토글 가능하다
   * (mentionable 과 동형). 시스템 OWNER·ADMIN 은 기본 true.
   */
  hoistInMemberList: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Role = z.infer<typeof RoleSchema>;

/**
 * S61 (FR-RM01): 커스텀 역할 생성 바디(ADMIN+). position 미지정 시 서버가 결정.
 *
 * S61 fix-forward (security HIGH-2): position 은 [0, 499] 정수만 허용합니다. 종전에는
 * 음수/거대값이 Zod 를 통과해 서비스 레이어의 position 비교(actorTop 등)에 흘러
 * 들어갔습니다. 시스템 OWNER position 은 500 으로 고정이므로 커스텀 역할은 항상 그
 * 미만(≤499)이어야 합니다.
 */
export const ROLE_POSITION_MIN = 0;
export const ROLE_POSITION_MAX = 499;
export const CreateRoleRequestSchema = z.object({
  name: RoleNameSchema,
  colorHex: ColorHexSchema.nullable().optional(),
  permissions: PermissionsBitfieldSchema.optional(),
  position: z.number().int().min(ROLE_POSITION_MIN).max(ROLE_POSITION_MAX).optional(),
  // S88a (FR-MN-03 · D6): 멘션 허용 플래그. 미지정 시 서버가 false(멘션 불가)로 생성.
  mentionable: z.boolean().optional(),
  // FR-P09 (task-068 · S95): hoist 플래그. 미지정 시 서버가 false(비-hoist)로 생성.
  hoistInMemberList: z.boolean().optional(),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

/**
 * S61 (FR-RM01/04): 역할 수정 바디. 시스템 역할은 name/position 변경 불가
 * (서버가 거부). permissions 변경은 privilege-escalation 방어 검사를 거칩니다.
 */
export const UpdateRoleRequestSchema = z
  .object({
    name: RoleNameSchema.optional(),
    colorHex: ColorHexSchema.nullable().optional(),
    permissions: PermissionsBitfieldSchema.optional(),
    // S61 fix-forward (security HIGH-2): [0, 499] 정수만(시스템 OWNER 500 미만).
    position: z.number().int().min(ROLE_POSITION_MIN).max(ROLE_POSITION_MAX).optional(),
    // S88a (FR-MN-03 · D6): 멘션 허용 토글. 시스템 역할도 변경 가능(비권한 메타).
    mentionable: z.boolean().optional(),
    // FR-P09 (task-068 · S95): hoist 토글. 시스템 역할도 변경 가능(비권한 메타 · mentionable 동형).
    hoistInMemberList: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.colorHex !== undefined ||
      d.permissions !== undefined ||
      d.position !== undefined ||
      d.mentionable !== undefined ||
      d.hoistInMemberList !== undefined,
    { message: 'at least one field must be provided' },
  );
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;

/** S61 (FR-RM01/04): 멤버 역할 부여/회수 바디. */
export const AssignRoleRequestSchema = z.object({
  roleId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

/** S61: MemberRole 응답 DTO. */
export const MemberRoleSchema = z.object({
  workspaceMemberWorkspaceId: z.string().uuid(),
  workspaceMemberUserId: z.string().uuid(),
  roleId: z.string().uuid(),
  assignedAt: z.string().datetime(),
  assignedBy: z.string().uuid().nullable(),
});
export type MemberRole = z.infer<typeof MemberRoleSchema>;
