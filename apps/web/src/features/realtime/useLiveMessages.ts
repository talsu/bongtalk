/**
 * Deprecated as of task-008. The centralized realtime dispatcher
 * (`./dispatcher.ts`) now handles message.created/updated/deleted for
 * every channel in one place, so per-channel subscriptions would just
 * double-fire. This no-op is kept so `MessageColumn`'s existing import
 * path stays stable; remove once callers are dropped.
 */
export function useLiveMessages(_wsId: string, _channelId: string): void {
  // intentionally empty — see `features/realtime/dispatcher.ts`
  void _wsId;
  void _channelId;
}
