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
  /** M2 리뷰 M-3: 서버 effective 값으로 로컬 표시만 동기화(PATCH 미발행). */
  hydrate: (next: PresenceStatus) => void;
  pending: boolean;
  error: string | null;
} {
  const [status, setStatusState] = useState<PresenceStatus>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStatus = useCallback(
    async (next: PresenceStatus) => {
      // S25: idle 은 자동 전용 — 사용자 설정 불가.
      //
      // 071-M2 리뷰 H-1: 종전엔 'offline' 도 무음 반환해, '오프라인 표시'를
      // 고른 사용자가 숨었다고 믿지만 실제로는 계속 온라인으로 노출되는 무음
      // 실패였다. UI 의 'offline'(오프라인 표시)은 와이어 'invisible' 로 매핑해
      // PATCH 한다(서버 허용 집합: online|dnd|invisible — self 라벨은 offline).
      if (next === 'idle') return;
      const wire = next === 'offline' ? 'invisible' : next;
      const prev = status;
      setStatusState(next);
      setPending(true);
      setError(null);
      try {
        await apiRequest('/me/presence', { method: 'PATCH', body: { status: wire } });
      } catch (e) {
        setStatusState(prev);
        setError((e as Error).message);
      } finally {
        setPending(false);
      }
    },
    [status],
  );

  return { status, setStatus, hydrate: setStatusState, pending, error };
}
