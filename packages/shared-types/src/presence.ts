import { z } from 'zod';

/**
 * Task-019-C / S25 (FR-P01): user-visible presence preference. Controls the
 * initial / persistent state the WS gateway writes to Redis on connect.
 *
 *   auto      — task-005 default (online on connect, offline on disconnect)
 *   dnd       — "Do Not Disturb"; connect shows dnd instead of online; idle/
 *               activity do not change it
 *   invisible — user appears OFFLINE to everyone else (maskPresenceForViewer);
 *               only the user themselves sees their real state
 *
 * Runtime presence (PresenceService Redis state) is still the source of
 * truth for live state; this field only chooses the initial/persistent value.
 */
export const PresencePreferenceSchema = z.enum(['auto', 'dnd', 'invisible']);
export type PresencePreference = z.infer<typeof PresencePreferenceSchema>;

/**
 * The UI exposes "Online", "Do not disturb" and "Invisible" as clickable
 * values. The PATCH body matches those three values directly; the server maps
 * them to the stored preference (online → auto, dnd → dnd, invisible →
 * invisible).
 */
export const UpdatePresenceRequestSchema = z.object({
  status: z.enum(['online', 'dnd', 'invisible']),
});
export type UpdatePresenceRequest = z.infer<typeof UpdatePresenceRequestSchema>;

export const UpdatePresenceResponseSchema = z.object({
  preference: PresencePreferenceSchema,
  /** Effective runtime status the gateway emitted after the PATCH (self view). */
  effective: z.enum(['online', 'dnd', 'offline', 'invisible']),
});
export type UpdatePresenceResponse = z.infer<typeof UpdatePresenceResponseSchema>;

/**
 * S19 (FR-DM-12): DM 수신권한(allowDmFrom). Prisma `DmPrivacy` enum 과 1:1 정합
 * (EVERYONE | WORKSPACE_MEMBER). FRIENDS_ONLY 는 Phase2 carryover — enum 값으로도
 * 선반영하지 않으므로 여기에도 없다(입력으로 받으면 400 거부).
 *
 *   EVERYONE         — 누구나 DM 개시 가능.
 *   WORKSPACE_MEMBER — 공통 워크스페이스 멤버이거나 ACCEPTED 친구만 가능(default).
 */
export const DmPrivacySchema = z.enum(['EVERYONE', 'WORKSPACE_MEMBER']);
export type DmPrivacy = z.infer<typeof DmPrivacySchema>;

/** PATCH /users/me/dm-privacy body. allowDmFrom 만 받는다(추가 필드 거부). */
export const SetDmPrivacyRequestSchema = z.object({
  allowDmFrom: DmPrivacySchema,
});
export type SetDmPrivacyRequest = z.infer<typeof SetDmPrivacyRequestSchema>;

// ── S28 (FR-P04/P06/P17): custom status + DND schedule (single source of truth)
//
// contract HIGH fix-forward: api(custom-status / dnd-schedule)·web(useCustomStatus
// / useDndSchedule) 가 동일 타입을 각자 로컬 정의해 3중 drift 를 만들었다. 모든
// shape 을 여기로 이관하고 api/web 이 import 한다.

/**
 * S28 (FR-P04): 커스텀 상태 만료 프리셋. 클라이언트가 브라우저 tz 로 절대 UTC
 * expiresAt 을 계산해 보내는 게 1차 경로이며, preset+timezone 을 그대로 넘기면
 * 서버가 동일 기준으로 계산한다(fallback).
 */
export const StatusPresetSchema = z.enum([
  'dont_clear',
  'thirty_min',
  'one_hour',
  'four_hours',
  'today',
  'this_week',
]);
export type StatusPreset = z.infer<typeof StatusPresetSchema>;

/** GET /users/me/status 응답 — lazy 만료 적용 후 현재 상태. */
export const CustomStatusViewSchema = z.object({
  text: z.string().nullable(),
  emoji: z.string().nullable(),
  /** ISO UTC 또는 null(무기한). */
  expiresAt: z.string().nullable(),
  /**
   * S74 (FR-PS-05 · Fork1 Option C): 커스텀상태 만료 시 DND 동시 활성화 옵션.
   * 현재 설정값(만료된다 해도 옵션 자체는 보존 — 사용자 환경 설정). 본인 read 전용.
   */
  dndDuringStatus: z.boolean().optional(),
});
export type CustomStatusView = z.infer<typeof CustomStatusViewSchema>;

/** PUT /users/me/status body. expiresAt(절대 UTC ISO) 가 preset 보다 우선. */
export const SetCustomStatusInputSchema = z
  .object({
    text: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    /** 절대 UTC ISO. preset 보다 우선. */
    expiresAt: z.string().nullable().optional(),
    /** 서버측 계산용 프리셋(expiresAt 미지정 시). */
    preset: StatusPresetSchema.optional(),
    /** IANA tz(프리셋 기준). */
    timezone: z.string().optional(),
    /**
     * S74 (FR-PS-05 · Fork1 Option C): 커스텀상태 만료(customStatusExpiresAt 도달) 시
     * DND 를 동시 활성화할지. 미지정이면 기존 값 유지(set 이 컬럼을 건드리지 않음).
     */
    dndDuringStatus: z.boolean().optional(),
  })
  .strict();
export type SetCustomStatusInput = z.infer<typeof SetCustomStatusInputSchema>;

/**
 * S28 (FR-P06): 주간 DND 스케줄 1 entry.
 *   day: 0(Sun)~6(Sat), startMin/endMin: 0~1439(분, 자정 기준).
 *   startMin>endMin 은 자정 걸침(overnight, 예: 23:00→07:00).
 */
export const DndEntrySchema = z.object({
  day: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(1439),
  endMin: z.number().int().min(0).max(1439),
});
export type DndEntry = z.infer<typeof DndEntrySchema>;

export const DndScheduleSchema = z.object({
  // S46 fix-forward (HIGH/DoS): days 길이 상한. 한 주(7일)당 최대 4 구간을 넉넉히
  // 잡아 28개로 제한해 무제한 배열 저장(메모리/저장소 DoS)을 막는다.
  days: z.array(DndEntrySchema).max(28),
});
export type DndSchedule = z.infer<typeof DndScheduleSchema>;

/** PATCH /me/dnd-schedule body. schedule(null = 해제) 만 받는다(추가 필드 거부). */
export const SetDndScheduleRequestSchema = z
  .object({
    schedule: DndScheduleSchema.nullable(),
  })
  .strict();
export type SetDndScheduleRequest = z.infer<typeof SetDndScheduleRequestSchema>;

/** GET/PATCH /me/dnd-schedule 응답 — 평가 후 effective preference 동반. */
export const DndScheduleResponseSchema = z.object({
  schedule: DndScheduleSchema.nullable(),
  preference: PresencePreferenceSchema,
});
export type DndScheduleResponse = z.infer<typeof DndScheduleResponseSchema>;
