import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { WS_EVENTS } from '@qufox/shared-types';

/**
 * S73 (D14 / FR-PS-17): 클라이언트 presence:activity 발행.
 *
 * 사용자의 `mousemove`/`keydown` 를 감지해 서버에 `presence:activity` 를 보낸다.
 * 서버(S25 onActivity)는 마지막 활동 시각을 갱신하고, IDLE 이었다면 ONLINE 으로
 * 되돌려 워크스페이스 룸에 방송한다. 마지막 활동 후 PRESENCE_IDLE_TIMEOUT(600s)
 * 무활동이면 서버 폴러가 IDLE 로 자동 전이한다(presence:changed).
 *
 * 고빈도 이벤트이므로 최대 30s 에 1회로 스로틀한다(서버 부하/방송 빈도 보호 —
 * S25 컨트랙트의 "1/30s" 기대치와 일치). 탭이 숨겨진 동안(visibilitychange:hidden)
 * 발행하지 않아 백그라운드 탭이 인위적으로 ONLINE 을 유지하지 못하게 한다.
 */
const ACTIVITY_THROTTLE_MS = 30_000;

export function usePresenceActivity(socket: Socket | null): void {
  useEffect(() => {
    if (!socket) return;
    let lastSent = 0;

    const send = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastSent < ACTIVITY_THROTTLE_MS) return;
      lastSent = now;
      socket.emit(WS_EVENTS.PRESENCE_ACTIVITY, {});
    };

    window.addEventListener('mousemove', send, { passive: true });
    window.addEventListener('keydown', send);
    return () => {
      window.removeEventListener('mousemove', send);
      window.removeEventListener('keydown', send);
    };
  }, [socket]);
}
