/**
 * Centralized room naming so the projection layer, the gateway, and the
 * tests all agree on exactly which string a socket will be joined to.
 *
 *   workspace:{wsId}  — membership/presence events for the whole workspace
 *   channel:{chId}    — message + channel-scoped events
 *   user:{userId}     — per-user private channel (membership kick, role chg)
 */
export const rooms = {
  workspace: (wsId: string): string => `workspace:${wsId}`,
  channel: (chId: string): string => `channel:${chId}`,
  user: (userId: string): string => `user:${userId}`,
} as const;
