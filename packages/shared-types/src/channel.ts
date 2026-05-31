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

export const CategoryNameSchema = z.string().min(1).max(32);

// S13 (FR-CH-10): 채널 설명. 채널 브라우저/헤더에 노출되는 ≤500자 자유 텍스트.
// DB 는 VarChar(500), 여기서 길이를 강제한다.
export const ChannelDescriptionSchema = z.string().max(500);

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
  // OWNER-only flip of privacy; enforced in ChannelsService.update.
  isPrivate: z.boolean().optional(),
});
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

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

// S12 BLOCKER: body of POST /channels/:chid/members. The masks default to 0
// (no-op override) and are bounded by PermissionMaskSchema so an ADMIN cannot
// inject an out-of-range / negative mask to escalate privileges.
export const ChannelMemberOverrideRequestSchema = z.object({
  userId: z.string().uuid(),
  allowMask: PermissionMaskSchema.optional().default(0),
  denyMask: PermissionMaskSchema.optional().default(0),
});
export type ChannelMemberOverrideRequest = z.infer<typeof ChannelMemberOverrideRequestSchema>;

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
