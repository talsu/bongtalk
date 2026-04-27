import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PresenceStatus } from '../presence/presenceStatus';
import { qk } from '../../lib/query-keys';

type PresenceCache = { online: string[]; dnd: string[] };

/**
 * task-041 A-3 (R7 DM-1 follow-up): aggregate presence across every
 * workspace the viewer belongs to. Workspace-scoped `presence.updated`
 * events are written by the realtime dispatcher under
 * `qk.presence.workspace(wsId)` for each workspace; the DM list lives
 * outside any single workspace context (workspaceless flow shipped in
 * 034). The DM peer's status must therefore be a UNION over all
 * workspaces — if the user shares any workspace with the viewer and
 * is online in any of them, render online.
 *
 * Memoless: the hook subscribes to the React Query cache and forces
 * a re-render on every presence-key change. Cheap because presence
 * keys are short tuples (`['presence', wsId]`) and the dispatcher
 * batches updates per WS event.
 */
export function useDmPresence(): {
  getStatus: (userId: string) => PresenceStatus;
  onlineUserIds: Set<string>;
  dndUserIds: Set<string>;
} {
  const qc = useQueryClient();
  const [, forceRender] = useState(0);

  useEffect(() => {
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const k = event.query.queryKey;
      if (Array.isArray(k) && k.length >= 2 && k[0] === 'presence') {
        forceRender((n) => n + 1);
      }
    });
    return unsubscribe;
  }, [qc]);

  // Walk every cached presence key and union the sets. Cache miss for
  // workspaces the viewer is in but hasn't received a presence snapshot
  // for yet → treat as offline (the dispatcher's initial snapshot
  // arrives within a tick of socket connect).
  const allPresence = qc.getQueriesData<PresenceCache>({ queryKey: qk.presence.all() });
  const online = new Set<string>();
  const dnd = new Set<string>();
  for (const [, data] of allPresence) {
    if (!data) continue;
    for (const id of data.online ?? []) online.add(id);
    for (const id of data.dnd ?? []) dnd.add(id);
  }

  const getStatus = (userId: string): PresenceStatus => {
    if (dnd.has(userId)) return 'dnd';
    if (online.has(userId)) return 'online';
    return 'offline';
  };

  return { getStatus, onlineUserIds: online, dndUserIds: dnd };
}
