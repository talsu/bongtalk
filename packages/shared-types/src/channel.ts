import { z } from 'zod';

export const ChannelTypeSchema = z.enum(['TEXT', 'VOICE', 'ANNOUNCEMENT']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const CHANNEL_RESERVED_NAMES: ReadonlySet<string> = new Set(['everyone', 'here']);

export const ChannelNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'channel name must be lowercase alphanum / _ / -');

export const CategoryNameSchema = z.string().min(1).max(32);

export const CreateChannelRequestSchema = z.object({
  name: ChannelNameSchema,
  type: ChannelTypeSchema.default('TEXT'),
  topic: z.string().max(1024).optional(),
  categoryId: z.string().uuid().nullable().optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const UpdateChannelRequestSchema = z.object({
  name: ChannelNameSchema.optional(),
  topic: z.string().max(1024).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
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

export const ChannelSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  name: ChannelNameSchema,
  type: ChannelTypeSchema,
  topic: z.string().nullable(),
  position: z.string(),
  isPrivate: z.boolean(),
  archivedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const CreateCategoryRequestSchema = z.object({
  name: CategoryNameSchema,
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export const UpdateCategoryRequestSchema = z.object({
  name: CategoryNameSchema.optional(),
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
