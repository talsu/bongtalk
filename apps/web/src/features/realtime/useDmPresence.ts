import { useEffect, useMemo, useRef, useState } from 'react';
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
 * task-042 R0 F2 (review M1 follow-up): memoize the union output so
 * presence broadcasts that didn't change the actual user-set don't
 * trigger downstream re-renders. Without this every presence.updated
 * event (every 15s × N workspaces ≈ 4–8 events/min steady state)
 * forced DmShell + MobileDmList to re-render the entire list. Now:
 *   - subscribe also includes `added` events (initial snapshot
 *     arrives via cache `added`, not `updated`)
 *   - dedup: signature = sorted-online + sorted-dnd hash. If the
 *     signature is unchanged after a cache event, skip the forceRender.
 *   - useMemo gates `getStatus` and the Sets so referential
 *     equality lets DmShell skip downstream re-render even on
 *     redundant cache rebuilds.
 */
export function useDmPresence(): {
  getStatus: (userId: string) => PresenceStatus;
  onlineUserIds: Set<string>;
  dndUserIds: Set<string>;
} {
  const qc = useQueryClient();
  const [, forceRender] = useState(0);
  const lastSignatureRef = useRef<string>('');

  useEffect(() => {
    const computeSignature = (): string => {
      const all = qc.getQueriesData<PresenceCache>({ queryKey: qk.presence.all() });
      const online: string[] = [];
      const dnd: string[] = [];
      for (const [, data] of all) {
        if (!data) continue;
        for (const id of data.online ?? []) online.push(id);
        for (const id of data.dnd ?? []) dnd.push(id);
      }
      online.sort();
      dnd.sort();
      return `o:${online.join(',')}|d:${dnd.join(',')}`;
    };
    lastSignatureRef.current = computeSignature();

    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      // Cover both `added` (initial snapshot) and `updated` (broadcast).
      if (event.type !== 'added' && event.type !== 'updated') return;
      const k = event.query.queryKey;
      if (!Array.isArray(k) || k.length < 2 || k[0] !== 'presence') return;
      const next = computeSignature();
      if (next === lastSignatureRef.current) return; // no-op event
      lastSignatureRef.current = next;
      forceRender((n) => n + 1);
    });
    return unsubscribe;
  }, [qc]);

  // useMemo keyed off the cached signature so getStatus + the Sets
  // keep stable identity across renders unless the union actually
  // changes. The Set instances themselves are deduped by signature
  // string, which is cheap to recompute.
  const memo = useMemo(() => {
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
    // lastSignatureRef.current changes only when forceRender fires,
    // so its value at render time is the dedup gate. The eslint-
    // recommended exhaustive-deps rule isn't installed in this repo's
    // flat config, so no pragma is needed.
  }, [qc, lastSignatureRef.current]);

  return memo;
}
