import { useEffect, useState } from 'react';
import { connect, disconnect, getLastEventId, setLastEventId } from '../../lib/socket';
import { getAccessToken } from '../../lib/api';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

/**
 * Owns the single-app socket lifecycle. Call once from the workspace layout.
 * Each emitted envelope (`id` field) is persisted as `lastEventId` so a
 * subsequent reconnect can ask the server for replay from that anchor.
 */
export function useRealtimeConnection(): { status: RealtimeStatus; replaying: boolean } {
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

    // Track envelope ids as they arrive so reconnect has a cursor.
    const trackId = (e: { id?: string }): void => {
      if (typeof e?.id === 'string') setLastEventId(e.id);
    };
    for (const t of [
      'message.created',
      'message.updated',
      'message.deleted',
      'channel.created',
      'channel.updated',
      'channel.deleted',
      'channel.moved',
      'channel.archived',
      'channel.unarchived',
      'workspace.member.joined',
      'workspace.member.left',
      'workspace.member.role_changed',
    ]) {
      socket.on(t, trackId);
    }

    socket.on('replay.complete', () => setReplaying(false));
    socket.on('replay.truncated', () => setReplaying(false));

    // Heartbeat so the server's 120s session TTL doesn't drop us.
    const ping = setInterval(() => socket.emit('presence:ping'), 15_000);

    // If handshake included lastEventId, we're in replay mode until complete.
    if (getLastEventId()) setReplaying(true);

    return () => {
      clearInterval(ping);
      disconnect();
    };
  }, []);

  return { status, replaying };
}
