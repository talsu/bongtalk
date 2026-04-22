import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';

type PresenceCache = { online: string[]; dnd: string[] };

/**
 * Reads the presence snapshot for a workspace from React Query cache.
 * The realtime dispatcher (installed once at Shell root) is the single
 * writer: every `presence.updated` broadcast lands here via
 * `qc.setQueryData(qk.presence.workspace(wsId), {...})`.
 *
 * Previously this hook attached its own `socket.on('presence.updated')`
 * listener. That was racy — if `getSocket()` returned `null` on first
 * render (shell still wiring up the realtime connection), the effect
 * silently bailed and never re-subscribed once the socket was ready,
 * leaving member status dots stuck at "offline" until the user
 * refreshed. Reading from the cache avoids the race entirely; the
 * dispatcher's listener is installed at the shell root and stays
 * attached across the socket's reconnect lifecycle.
 */
export function usePresence(workspaceId: string | undefined): {
  onlineUserIds: Set<string>;
  dndUserIds: Set<string>;
} {
  const qc = useQueryClient();
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!workspaceId) return;
    const key = qk.presence.workspace(workspaceId);
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const qKey = event.query.queryKey;
      if (!Array.isArray(qKey) || qKey.length !== key.length) return;
      if (qKey.every((seg, i) => seg === key[i])) forceRender((n) => n + 1);
    });
    return unsubscribe;
  }, [qc, workspaceId]);

  const data = workspaceId
    ? qc.getQueryData<PresenceCache>(qk.presence.workspace(workspaceId))
    : undefined;
  return {
    onlineUserIds: new Set(data?.online ?? []),
    dndUserIds: new Set(data?.dnd ?? []),
  };
}
