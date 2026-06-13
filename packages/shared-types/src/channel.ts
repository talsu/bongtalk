import { z } from 'zod';
import { isValidPermissionMaskNumber } from './permissions';

// S12 (FR-CH-01): FORUM is the third creatable text-surface type alongside
// TEXT and ANNOUNCEMENT. VOICE stays in the enum for back-compat / future
// voice slices but is rejected at the service layer as not-implemented.
export const ChannelTypeSchema = z.enum(['TEXT', 'VOICE', 'ANNOUNCEMENT', 'FORUM']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

// S12 BLOCKER: a permission mask carried over the wire as a JS number. Must be
// a non-negative integer whose bits all fall inside the defined permission set
// (ALL_PERMISSIONS). Blocks privilege escalation via allowMask:-1 or undefined
// bits (e.g. ADMINISTRATOR / reserved bits 13..62).
export const PermissionMaskSchema = z
  .number()
  .int()
  .nonnegative()
  .refine((v) => isValidPermissionMaskNumber(v), {
    message: 'permission mask out of range',
  });

export const CHANNEL_RESERVED_NAMES: ReadonlySet<string> = new Set(['everyone', 'here']);

export const ChannelNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'channel name must be lowercase alphanum / _ / -');

// S15 (FR-CH-12): 카테고리 이름 2~50자. (이전 1~32 에서 PRD 명세에 맞춰 확장.)
export const CategoryNameSchema = z.string().min(2).max(50);

// S13 (FR-CH-10): 채널 설명. 채널 브라우저/헤더에 노출되는 ≤500자 자유 텍스트.
// DB 는 VarChar(500), 여기서 길이를 강제한다.
export const ChannelDescriptionSchema = z.string().max(500);

// S15 (FR-CH-08): 슬로우모드 간격(초). 0=비활성, 상한 6시간(21600초, Discord 동일).
// 비정수/음수/상한 초과는 거부한다.
export const SlowmodeSecondsSchema = z.number().int().min(0).max(21600);

// S55 (FR-AM-20): 채널별 최대 첨부 크기(바이트). 양의 정수, 상한 100MB(전역 한도와
// 정합). null 이면 워크스페이스 설정 → 전역 기본 순으로 폴백.
export const ChannelMaxFileSizeSchema = z
  .number()
  .int()
  .positive()
  .max(100 * 1024 * 1024);

export const CreateChannelRequestSchema = z.object({
  name: ChannelNameSchema,
  type: ChannelTypeSchema.default('TEXT'),
  topic: z.string().max(1024).optional(),
  // S13 (FR-CH-10): 생성 시 선택 입력. 미지정이면 null.
  description: ChannelDescriptionSchema.optional(),
  categoryId: z.string().uuid().nullable().optional(),
  // Task-012-D reviewer HIGH-1 fix: without this field, `zod.parse`
  // strips `isPrivate` silently and private channels are only
  // creatable via direct SQL. The default matches the Prisma default
  // so pre-012 clients keep getting public channels.
  isPrivate: z.boolean().optional().default(false),
});
// `z.input` (not `z.infer`) keeps `isPrivate` OPTIONAL in the request
// type so existing callers that never set it continue to typecheck.
// Parsed output type (post-default) has `isPrivate: boolean`.
export type CreateChannelRequest = z.input<typeof CreateChannelRequestSchema>;

export const UpdateChannelRequestSchema = z.object({
  name: ChannelNameSchema.optional(),
  topic: z.string().max(1024).nullable().optional(),
  // S13 (FR-CH-10): null 로 설명 삭제, 문자열로 갱신, undefined 면 변경 없음.
  description: ChannelDescriptionSchema.nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  // S15 (FR-CH-08): 슬로우모드 간격(초). 미지정이면 변경 없음, 0 이면 비활성화.
  slowmodeSeconds: SlowmodeSecondsSchema.optional(),
  // S51 (FR-PS-05): 핀 권한 채널 오버라이드. true = 채널 멤버 전체 허용,
  // false = MODERATOR/ADMIN 이상으로 제한(워크스페이스 ADMIN/OWNER 는 항상 가능).
  // 미지정이면 변경 없음. 채널 설정 변경 권한(MANAGE_CHANNEL/ADMIN+) 게이트는 PATCH
  // 라우트가 기존대로 강제한다.
  memberCanPin: z.boolean().optional(),
  // S55 (FR-CH-18): 채널별 첨부 업로드 토글. 미지정이면 변경 없음. false 면
  // upload-url 게이트가 403. MANAGE_CHANNEL/ADMIN+ 게이트는 PATCH 라우트가 강제한다.
  fileUploadEnabled: z.boolean().optional(),
  // S55 (FR-AM-20): 채널별 최대 첨부 크기(바이트). null 로 채널 오버라이드 해제
  // (워크스페이스 설정 폴백), 양의 정수로 설정, 미지정이면 변경 없음.
  maxFileSizeBytes: ChannelMaxFileSizeSchema.nullable().optional(),
  // OWNER/ADMIN flip of privacy; enforced in ChannelsService.update.
  isPrivate: z.boolean().optional(),
  // S14 (FR-CH-05): 비공개→공개 전환 confirm 토큰. 서버는 isPrivate:false 로의
  // 전환(현재 비공개 → 공개)일 때 이 값이 채널의 현재 name 과 정확히 일치하는지
  // 검증한다. 누락/불일치 시 CHANNEL_CONFIRM_REQUIRED(400). 공개→비공개 또는
  // 권한 변경 없는 PATCH 에는 불요. 길이 상한은 채널명과 동일(32).
  confirmName: z.string().max(64).optional(),
});
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

// S14 (FR-CH-11): ROLE-principal 권한 오버라이드 설정 바디. allow/deny 마스크는
// 집행 비트필드(0xFF) 범위로 검증한다(controller 의 ALL_PERMISSIONS 범위 체크
// 재사용). role 은 WorkspaceRole 리터럴. allowMask/denyMask 0 은 no-op(해제).
export const ChannelRoleOverrideRequestSchema = z.object({
  // S61: 시스템 역할 5단계 확장.
  role: z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']),
  allowMask: PermissionMaskSchema.optional().default(0),
  denyMask: PermissionMaskSchema.optional().default(0),
});
export type ChannelRoleOverrideRequest = z.infer<typeof ChannelRoleOverrideRequestSchema>;

export const MoveChannelRequestSchema = z
  .object({
    categoryId: z.string().uuid().nullable().optional(),
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
  })
  .refine((x) => !(x.beforeId && x.afterId), {
    message: 'beforeId and afterId are mutually exclusive',
  });
export type MoveChannelRequest = z.infer<typeof MoveChannelRequestSchema>;

// S15 (FR-CH-13): 배치 재정렬. 클라이언트가 최종 순서(id 배열)를 통째로 보내면
// 서버가 1000 등간격(fractional position)으로 재정규화한다. channel 항목은
// categoryId 도 함께 전달해 카테고리 간 이동을 한 번에 반영한다. id 는 1~200개.
export const ReorderChannelsRequestSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        categoryId: z.string().uuid().nullable(),
      }),
    )
    .min(1)
    .max(200),
});
export type ReorderChannelsRequest = z.infer<typeof ReorderChannelsRequestSchema>;

export const ReorderCategoriesRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderCategoriesRequest = z.infer<typeof ReorderCategoriesRequestSchema>;

// S12 BLOCKER: body of POST /channels/:chid/members. The masks default to 0
// (no-op override) and are bounded by PermissionMaskSchema so an ADMIN cannot
// inject an out-of-range / negative mask to escalate privileges.
export const ChannelMemberOverrideRequestSchema = z.object({
  userId: z.string().uuid(),
  allowMask: PermissionMaskSchema.optional().default(0),
  denyMask: PermissionMaskSchema.optional().default(0),
});
export type ChannelMemberOverrideRequest = z.infer<typeof ChannelMemberOverrideRequestSchema>;

/**
 * S62 (FR-RM14 · Fork B / ADR-11): 채널 권한 오버라이드 응답 DTO. allow/deny 마스크는
 * Prisma BigInt 컬럼이므로 BigIntSerializationInterceptor 정합을 위해 **string**
 * (BigInt-as-string)으로 내린다. 종전 `Number(...)` 우회는 인터셉터와 어긋났다
 * (S61 555줄 TODO). 프론트엔드는 `BigInt(value)` 로 파싱한다.
 *
 * 집행 도메인(0x1FF) 비트만 담기지만(controller 가 ALL_PERMISSIONS 로 검증), 컬럼이
 * BigInt 라 직렬화 계약을 string 으로 통일한다.
 */
export const ChannelPermissionOverrideSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  principalType: z.enum(['USER', 'ROLE']),
  // USER: User.id(UUID) · ROLE: 시스템 역할 리터럴(OWNER/…) 또는 커스텀 Role.id(UUID).
  principalId: z.string(),
  /** ADR-11: BigInt 비트필드를 string 으로 직렬화. FE 는 BigInt(value) 파싱. */
  allowMask: z.string(),
  denyMask: z.string(),
});
export type ChannelPermissionOverride = z.infer<typeof ChannelPermissionOverrideSchema>;

/** S62 (FR-RM14): 채널 오버라이드 목록 응답. UI 가 역할/멤버 3-state 토글을 그린다. */
export const ChannelPermissionOverrideListResponseSchema = z.object({
  overrides: z.array(ChannelPermissionOverrideSchema),
});
export type ChannelPermissionOverrideListResponse = z.infer<
  typeof ChannelPermissionOverrideListResponseSchema
>;

export const ChannelSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  name: ChannelNameSchema,
  type: ChannelTypeSchema,
  topic: z.string().nullable(),
  // S13 (FR-CH-10): 채널 목록/단건 응답에 노출.
  description: z.string().nullable(),
  position: z.string(),
  // S15 (FR-CH-08): 슬로우모드 간격(초). 0=비활성.
  slowmodeSeconds: z.number().int().nonnegative(),
  // S51 (FR-PS-05): 핀 권한 채널 오버라이드. true(기본) = 멤버 전체 허용.
  memberCanPin: z.boolean(),
  // S55 (FR-CH-18): 채널별 첨부 업로드 토글. true(기본) = 허용.
  fileUploadEnabled: z.boolean(),
  // S55 (FR-AM-20): 채널별 최대 첨부 크기(바이트, 와이어상 number). null = 폴백.
  // 상한(전역 ATTACHMENT_MAX_BYTES)을 응답 스키마에도 반영(입력 ChannelMaxFileSizeSchema 와 정합).
  maxFileSizeBytes: ChannelMaxFileSizeSchema.nullable(),
  isPrivate: z.boolean(),
  archivedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const CreateCategoryRequestSchema = z.object({
  name: CategoryNameSchema,
  description: z.string().max(1024).optional(),
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export const UpdateCategoryRequestSchema = z.object({
  name: CategoryNameSchema.optional(),
  description: z.string().max(1024).nullable().optional(),
});
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;

export const MoveCategoryRequestSchema = z
  .object({
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
  })
  .refine((x) => !(x.beforeId && x.afterId), {
    message: 'beforeId and afterId are mutually exclusive',
  });
export type MoveCategoryRequest = z.infer<typeof MoveCategoryRequestSchema>;

export const CategorySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: CategoryNameSchema,
  description: z.string().nullable(),
  position: z.string(),
  createdAt: z.string().datetime(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryWithChannelsSchema = CategorySchema.extend({
  channels: z.array(ChannelSchema),
});
export type CategoryWithChannels = z.infer<typeof CategoryWithChannelsSchema>;

export const ChannelListResponseSchema = z.object({
  categories: z.array(CategoryWithChannelsSchema),
  uncategorized: z.array(ChannelSchema),
});
export type ChannelListResponse = z.infer<typeof ChannelListResponseSchema>;

// 072 백로그 S-D (FR-CH-06): 채널 둘러보기 항목 — 공개 채널 + 가입 분기용 메타.
//   - memberCount: 채널에 가입(opt-in)한 USER 수. 공개 채널 join 은 allowMask:0n opt-in
//     마커 override 행을 만들므로(allowMask>0 아님), USER override 행 수로 집계한다.
//   - isMember: 호출자의 USER override 행 존재 여부 → FE 가 "열기"/"가입" 버튼을 분기한다.
// 사이드바 핫패스(ChannelListResponse)는 건드리지 않고 전용 둘러보기 응답에만 싣는다.
export const ChannelBrowseItemSchema = ChannelSchema.extend({
  memberCount: z.number().int().nonnegative(),
  isMember: z.boolean(),
});
export type ChannelBrowseItem = z.infer<typeof ChannelBrowseItemSchema>;

export const ListBrowsableChannelsResponseSchema = z.object({
  channels: z.array(ChannelBrowseItemSchema),
});
export type ListBrowsableChannelsResponse = z.infer<typeof ListBrowsableChannelsResponseSchema>;

// S43 (FR-CH-15): 즐겨찾기 재정렬 바디. 채널 move 와 동일한 fractional anchor
// 규약을 따른다 — beforeId / afterId 는 상호 배타이며 둘 다 없으면 말단으로
// 간주한다(서버 calcBetween 재사용). anchor 는 즐겨찾기 목록 안의 채널 id 다.
export const MoveFavoriteRequestSchema = z
  .object({
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
  })
  .refine((x) => !(x.beforeId && x.afterId), {
    message: 'beforeId and afterId are mutually exclusive',
  });
export type MoveFavoriteRequest = z.infer<typeof MoveFavoriteRequestSchema>;

// S43 (FR-CH-15): 단일 즐겨찾기 항목. position 은 와이어상 문자열(Decimal 직렬화).
export const FavoriteSchema = z.object({
  channelId: z.string().uuid(),
  position: z.string(),
  createdAt: z.string().datetime(),
});
export type Favorite = z.infer<typeof FavoriteSchema>;

// S43 (FR-CH-15): GET /me/favorites 응답. position 오름차순 정렬.
export const FavoritesResponseSchema = z.object({
  items: z.array(FavoriteSchema),
});
export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>;
