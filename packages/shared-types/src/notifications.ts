import { z } from 'zod';
import { DndScheduleSchema } from './presence';

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
export const NotificationEventTypeSchema = z.enum([
  'MENTION',
  'REPLY',
  'REACTION',
  'DIRECT',
  'FRIEND_REQUEST',
]);
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

/**
 * S46 (D06 / ADR-6 / FR-MN-05/06/07/08): NotifLevel 카노니컬 모델.
 *
 * 알림 레벨 3값 enum. 글로벌(UserSettings.notifTrigger) → 서버
 * (ServerNotificationPref.level) → 채널(UserChannelMute.level, null=상속)
 * 3계층이 모두 이 enum 을 공유한다(ADR-6). `isMuted` + `muteUntil` 은 level
 * 과 독립한 3-필드 세트로, 뮤트는 별도 표현이다(NOTHING 과 구별 — ADR-6 표).
 *
 *   ALL      — 모든 메시지 알림(배지 + 미읽 + 멘션 전부 통과).
 *   MENTIONS — 멘션·키워드만(broad @everyone/@here 는 스킵, 직접 @username 통과). 기본값.
 *   NOTHING  — 알림 없음(멘션 outbox 스킵 — 직접 @username 은 통과해 Inbox 기록은 S47).
 *
 * 기존 NotificationChannel(TOAST/BROWSER)과는 별개 축이다(breaking 금지 —
 * 기존 /me/notification-preferences 는 그대로 유지).
 */
export const NotifLevelSchema = z.enum(['ALL', 'MENTIONS', 'NOTHING']);
export type NotifLevel = z.infer<typeof NotifLevelSchema>;

/**
 * S46 (FR-MN-06/07/08): 서버/채널 뮤트 기간 키. 'forever' = 영구(muteUntil null).
 * 그 외는 now + 해당 밀리초의 muteUntil 시각으로 변환한다.
 */
export const MuteDurationKeySchema = z.enum(['15m', '1h', '8h', '24h', 'forever']);
export type MuteDurationKey = z.infer<typeof MuteDurationKeySchema>;

// ── 글로벌 (UserSettings.notifTrigger) — GET/PATCH /me/settings/notifications ──

export const GlobalNotificationSettingsSchema = z.object({
  notifTrigger: NotifLevelSchema,
  // 키워드 알림(최대 25개). S46 은 컬럼 저장만 — 실제 스캔은 BullMQ(S45) 후속.
  keywords: z.array(z.string()),
  // 임시 DND 종료 시각(ISO) 또는 null. 스케줄(dndSchedule)과 독립한 1회성 DND.
  dndUntil: z.string().datetime().nullable(),
  // 주간 DND 스케줄(presence 의 카노니컬 DndScheduleSchema 재사용). null = 미설정.
  dndSchedule: DndScheduleSchema.nullable(),
});
export type GlobalNotificationSettings = z.infer<typeof GlobalNotificationSettingsSchema>;

export const UpdateGlobalNotificationSettingsRequestSchema = z
  .object({
    notifTrigger: NotifLevelSchema.optional(),
    keywords: z.array(z.string().min(1).max(100)).max(25).optional(),
    dndUntil: z.string().datetime().nullable().optional(),
    dndSchedule: DndScheduleSchema.nullable().optional(),
  })
  .strict();
export type UpdateGlobalNotificationSettingsRequest = z.infer<
  typeof UpdateGlobalNotificationSettingsRequestSchema
>;

// ── 서버 (ServerNotificationPref) — GET/PUT /workspaces/:wsId/notification-preferences ──

export const ServerNotificationPreferenceSchema = z.object({
  level: NotifLevelSchema,
  isMuted: z.boolean(),
  muteUntil: z.string().datetime().nullable(),
  suppressEveryone: z.boolean(),
  suppressRoleMentions: z.boolean(),
});
export type ServerNotificationPreference = z.infer<typeof ServerNotificationPreferenceSchema>;

export const PutServerNotificationPreferenceRequestSchema = z
  .object({
    level: NotifLevelSchema.optional(),
    isMuted: z.boolean().optional(),
    // 뮤트 기간 — isMuted=true 와 함께 보낸다. 미지정 시 영구('forever').
    muteDuration: MuteDurationKeySchema.optional(),
    suppressEveryone: z.boolean().optional(),
    suppressRoleMentions: z.boolean().optional(),
  })
  .strict();
export type PutServerNotificationPreferenceRequest = z.infer<
  typeof PutServerNotificationPreferenceRequestSchema
>;

// ── 채널 (UserChannelMute + level) — GET/PUT /workspaces/:wsId/channels/:chId/notification-preferences ──

export const ChannelNotificationPreferenceSchema = z.object({
  // null = 서버 상속(additive — 기존 UserChannelMute 행은 NULL).
  level: NotifLevelSchema.nullable(),
  isMuted: z.boolean(),
  muteUntil: z.string().datetime().nullable(),
});
export type ChannelNotificationPreference = z.infer<typeof ChannelNotificationPreferenceSchema>;

export const PutChannelNotificationPreferenceRequestSchema = z
  .object({
    level: NotifLevelSchema.nullable().optional(),
    isMuted: z.boolean().optional(),
    muteDuration: MuteDurationKeySchema.optional(),
    // 카테고리 일괄 적용: 지정 시 해당 카테고리의 하위 채널 전체에 동일 설정을
    // bulk upsert 한다(FR-MN-07). 미지정 시 path 의 단일 채널만.
    categoryId: UuidSchema.optional(),
  })
  .strict();
export type PutChannelNotificationPreferenceRequest = z.infer<
  typeof PutChannelNotificationPreferenceRequestSchema
>;

/**
 * S46 (선택): WS 이벤트 `notification:prefs_updated` payload. 다기기 반영용.
 * scope 별로 level/isMuted/muteUntil 을 실어 보낸다.
 *
 * TODO(notif-prefs-realtime): 현재 미배선 contract — 서버 emit / 클라 구독 어느
 * 쪽도 이 스키마를 쓰지 않는다. 다기기 실시간 반영(Redis TTL push)을 구현하는
 * 후속 슬라이스에서 WS_EVENTS·게이트웨이 핸들러에 배선하거나, 그 전까지 영구
 * 보류로 판단되면 이 export 를 제거한다. (S46 fix-forward carryover — dead
 * contract 가시화: 스키마만 살아 있고 소비처가 없음을 명시.)
 */
export const NotificationPrefsUpdatedPayloadSchema = z.object({
  scope: z.enum(['global', 'server', 'channel']),
  workspaceId: UuidSchema.nullable(),
  channelId: UuidSchema.nullable(),
  level: NotifLevelSchema.nullable(),
  isMuted: z.boolean(),
  muteUntil: z.string().datetime().nullable(),
});
export type NotificationPrefsUpdatedPayload = z.infer<typeof NotificationPrefsUpdatedPayloadSchema>;
