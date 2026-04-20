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
