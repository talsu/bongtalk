/**
 * Task-018-D: 3-state presence enum. Matches the Full Chat Mockup
 * (index.html lines 620-625) which renders three states on the member
 * list:
 *
 *   - online:  qf-avatar__status--online (green dot on avatar corner)
 *   - dnd:     qf-avatar__status--dnd    (red dot on avatar corner)
 *   - offline: no status dot; member row at 0.5 opacity
 *
 * Backend wiring (apps/api/src/realtime/presence/**) currently only
 * emits online / offline — users flip to offline when their WS
 * session expires. The `dnd` value is reserved for a future settings
 * UI where users can mute notifications while still showing as
 * connected; see `docs/tasks/018-ds-mockup-parity.md` §Design Decisions.
 * 018 ships the enum + render path so the dnd dot works the moment
 * backend starts emitting it.
 */
export type PresenceStatus = 'online' | 'dnd' | 'offline';
