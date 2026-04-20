import { useCallback, useState } from 'react';
import { apiRequest } from '../../lib/api';
import type { PresenceStatus } from './presenceStatus';

/**
 * Task-019-C: tiny hook for the BottomBar DnD toggle. The server is
 * the source of truth (via PATCH /me/presence); this hook holds the
 * optimistic value so the user sees the dot flip instantly. A
 * rejected call reverts to the last-known-good.
 */
export function usePresenceStatus(initial: PresenceStatus = 'online'): {
  status: PresenceStatus;
  setStatus: (next: PresenceStatus) => Promise<void>;
  pending: boolean;
  error: string | null;
} {
  const [status, setStatusState] = useState<PresenceStatus>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStatus = useCallback(
    async (next: PresenceStatus) => {
      if (next === 'offline') return; // not user-settable
      const prev = status;
      setStatusState(next);
      setPending(true);
      setError(null);
      try {
        await apiRequest('/me/presence', { method: 'PATCH', body: { status: next } });
      } catch (e) {
        setStatusState(prev);
        setError((e as Error).message);
      } finally {
        setPending(false);
      }
    },
    [status],
  );

  return { status, setStatus, pending, error };
}
