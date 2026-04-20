import { z } from 'zod';

const UuidSchema = z.string().uuid();

/**
 * Task-019-D: notification preferences.
 *
 * Four event types the user can route. Each preference row picks a
 * delivery channel: TOAST (in-app only), BROWSER (Notification API
 * only), BOTH, or OFF. A `null` workspaceId means the row is the
 * global default; a specific workspaceId scopes to that workspace
 * and beats the global row on lookup.
 */
export const NotificationEventTypeSchema = z.enum(['MENTION', 'REPLY', 'REACTION', 'DIRECT']);
export type NotificationEventType = z.infer<typeof NotificationEventTypeSchema>;

export const NotificationChannelSchema = z.enum(['TOAST', 'BROWSER', 'BOTH', 'OFF']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationPreferenceSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema.nullable(),
  eventType: NotificationEventTypeSchema,
  channel: NotificationChannelSchema,
  updatedAt: z.string().datetime(),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const ListNotificationPreferencesResponseSchema = z.object({
  preferences: z.array(NotificationPreferenceSchema),
});
export type ListNotificationPreferencesResponse = z.infer<
  typeof ListNotificationPreferencesResponseSchema
>;

export const UpsertNotificationPreferenceRequestSchema = z.object({
  workspaceId: UuidSchema.nullable().optional(),
  eventType: NotificationEventTypeSchema,
  channel: NotificationChannelSchema,
});
export type UpsertNotificationPreferenceRequest = z.infer<
  typeof UpsertNotificationPreferenceRequestSchema
>;
