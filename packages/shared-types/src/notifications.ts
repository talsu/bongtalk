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
 *
 * S49 fix-forward (contract HIGH): '3h' 추가 — web(useMutes·ChannelList MUTE_DURATIONS)이
 * PRD(FR-CH-17: 15분/1시간/3시간/8시간/24시간/무기한)대로 이미 '3h' 를 보내지만 이
 * 카노니컬 enum 에는 빠져 있어 drift 였다. 서버 muteUntilFrom('3h') 매핑도 함께 보강.
 */
export const MuteDurationKeySchema = z.enum(['15m', '1h', '3h', '8h', '24h', 'forever']);
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
    // S48 (FR-MN-10): 비즈 한도(25개)는 **서비스 레이어**가 KEYWORD_LIMIT_EXCEEDED 로
    // 단일 enforce 한다(전용 errorCode 로 클라 토스트 분기). Zod 는 형태(문자열)만
    // 검증하고 비즈 .max(25) 는 두지 않는다 — 서비스가 trim/dedupe 후 개수를 권위 판정.
    // S48 fix-forward(security): 다만 **형태 상한**(문자열당 200자·배열 100개)을 둬
    // 대형 payload 를 게이트웨이 단에서 조기 거부한다(비즈 한도 25/100 과 분리 — 정상
    // 클라는 절대 닿지 않는 안전 상한이라 비차단, 악성 대형 입력만 차단).
    keywords: z.array(z.string().max(200)).max(100).optional(),
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

// ── 뮤트 목록 (FR-MN-17) — GET /me/mutes · GET /me/server-mutes ──────────────

/**
 * S49 (D06 / FR-MN-17): "현재 뮤트 중" 목록의 채널 항목.
 *
 * 기존 GET /me/mutes 응답({channelId, mutedUntil, createdAt})을 Channel/Workspace
 * join 으로 보강한다 — 설정 화면의 뮤트 목록이 채널명·소속 서버명을 곧장 표시한다.
 * 삭제 채널(Channel.deletedAt IS NOT NULL)은 서버가 제외한다(목록에 노출 안 함).
 * isMuted=true 활성 뮤트만(만료 행은 query-time 제외 — listActiveMutes 정책 유지).
 *
 * workspaceId/workspaceName 은 nullable — DM 채널(workspaceId NULL)은 서버 소속이
 * 없으므로 null 이다(목록은 "DM" 로 렌더할 수 있다).
 */
export const ActiveChannelMuteSchema = z.object({
  channelId: UuidSchema,
  channelName: z.string(),
  workspaceId: UuidSchema.nullable(),
  workspaceName: z.string().nullable(),
  mutedUntil: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ActiveChannelMute = z.infer<typeof ActiveChannelMuteSchema>;

export const ListChannelMutesResponseSchema = z.object({
  items: z.array(ActiveChannelMuteSchema),
});
export type ListChannelMutesResponse = z.infer<typeof ListChannelMutesResponseSchema>;

/**
 * S49 (FR-MN-17): "현재 뮤트 중" 목록의 서버(워크스페이스) 항목.
 *
 * ServerNotificationPref 중 isMuted=true 이고 (muteUntil IS NULL=영구 | muteUntil>now)
 * 인 활성 서버 뮤트만. level 은 동반 표시용(서버 알림 수준). workspaceIconUrl 은
 * 미설정 시 null(기본 아바타).
 */
export const ActiveServerMuteSchema = z.object({
  workspaceId: UuidSchema,
  workspaceName: z.string(),
  workspaceIconUrl: z.string().nullable(),
  muteUntil: z.string().datetime().nullable(),
  level: NotifLevelSchema,
});
export type ActiveServerMute = z.infer<typeof ActiveServerMuteSchema>;

export const ListServerMutesResponseSchema = z.object({
  items: z.array(ActiveServerMuteSchema),
});
export type ListServerMutesResponse = z.infer<typeof ListServerMutesResponseSchema>;

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
