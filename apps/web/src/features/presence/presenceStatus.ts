/**
 * Task-018-D / S25 (FR-P01/RT-10): presence enum for the member list dot.
 *
 *   - online:  qf-avatar__status--online (green dot on avatar corner)
 *   - idle:    qf-avatar__status--idle   (yellow dot — auto-idle after 10min)
 *   - dnd:     qf-avatar__status--dnd    (red dot on avatar corner)
 *   - offline: no status dot; member row at 0.5 opacity
 *
 * INVISIBLE is intentionally absent: the server masks invisible → offline for
 * every other viewer (maskPresenceForViewer), so a remote user is only ever
 * one of these four. The user's own invisible state is settable via the
 * presence chip but never broadcast to peers.
 *
 * S25 backend (apps/api/src/realtime/presence/**) now emits online / idle /
 * dnd via the workspace `presence.updated` broadcast (onlineUserIds /
 * idleUserIds / dndUserIds); absence from all three sets renders offline.
 */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';
