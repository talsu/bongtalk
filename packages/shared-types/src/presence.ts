import { z } from 'zod';

/**
 * Task-019-C: user-visible presence preference. Controls the initial
 * state the WS gateway writes to Redis on connect.
 *
 *   auto — task-005 default (online on connect, offline on disconnect)
 *   dnd  — user is "Do Not Disturb"; connect shows dnd instead of online
 *
 * Runtime presence (PresenceService Redis SET) is still the source of
 * truth for live state; this field only chooses the initial value.
 */
export const PresencePreferenceSchema = z.enum(['auto', 'dnd']);
export type PresencePreference = z.infer<typeof PresencePreferenceSchema>;

/**
 * The UI exposes "Online" and "Do not disturb" as the two clickable
 * values plus a disabled "Invisible" placeholder. The PATCH body
 * matches those two values directly; the server maps them to the
 * stored preference.
 */
export const UpdatePresenceRequestSchema = z.object({
  status: z.enum(['online', 'dnd']),
});
export type UpdatePresenceRequest = z.infer<typeof UpdatePresenceRequestSchema>;

export const UpdatePresenceResponseSchema = z.object({
  preference: PresencePreferenceSchema,
  /** Effective runtime status the gateway emitted after the PATCH. */
  effective: z.enum(['online', 'dnd', 'offline']),
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
