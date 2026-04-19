import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connect, disconnect, getLastEventId, setLastEventId } from '../../lib/socket';
import { getAccessToken } from '../../lib/api';
import { useUI } from '../../stores/ui-store';
import { installRealtimeDispatcher, DISPATCHED_EVENTS } from './dispatcher';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

/**
 * Owns the single-app socket lifecycle. Installed once at the Shell root.
 * A central `dispatcher` is the ONLY thing that mutates React Query state
 * in response to server events — other hooks consume the resulting cache.
 *
 * Connection-level side-effects kept here:
 *   - tracking the most recent envelope id into localStorage for replay
 *   - presence heartbeat every 15s
 *   - status flag for the UI
 */
export function useRealtimeConnection(): { status: RealtimeStatus; replaying: boolean } {
  const qc = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    setStatus('connecting');
    const socket = connect(token, getLastEventId());

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('disconnected'));

    // Cache-mutation side of realtime (single dispatcher).
    // DispatcherContext gives the unread-bump path awareness of both
    // the viewer and the currently-open channel so the dispatcher skips
    // bumps for self-authored messages AND for messages that arrive on
    // the channel the user is actively reading (Discord semantic: "I
    // saw it, it's read"). MessageColumn writes activeChannelId into
    // the UI store on mount / unmount.
    const detach = installRealtimeDispatcher(socket, qc, {
      viewerId: () => {
        const me = qc.getQueryData<{ id: string } | undefined>(['auth', 'me']);
        return me?.id ?? null;
      },
      activeChannelId: () => useUI.getState().activeChannelId,
    });

    // Independent side: track envelope.id into localStorage so a later
    // reconnect can ask the server for replay-after.
    const trackId = (e: { id?: string }): void => {
      if (typeof e?.id === 'string') setLastEventId(e.id);
    };
    for (const t of DISPATCHED_EVENTS) socket.on(t, trackId);

    socket.on('replay.complete', () => setReplaying(false));
    socket.on('replay.truncated', () => setReplaying(false));

    const ping = setInterval(() => socket.emit('presence:ping'), 15_000);
    if (getLastEventId()) setReplaying(true);

    return () => {
      clearInterval(ping);
      for (const t of DISPATCHED_EVENTS) socket.off(t, trackId);
      detach();
      disconnect();
    };
  }, [qc]);

  return { status, replaying };
}
