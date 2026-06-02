import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { apiRequest } from '../../lib/api';
import { useBadgeStore } from './badgeStore';
import { BadgeResyncController, type BadgeResyncResult } from './badgeResync';

/**
 * S47 (FR-MN-20): 배지 재동기화 hook. visibilitychange(hidden→visible) 와 소켓
 * reconnect 시 1회 `GET /me/notification-badges` 를 호출(debounce 500ms · inflight
 * dedup)해 badgeStore 를 서버 진실값으로 전체 교체한다. **30초 polling 미사용** —
 * setInterval 을 등록하지 않는다.
 *
 * 소켓은 useRealtimeConnection 이 보유하므로 인자로 주입받아 같은 생명주기에 묶는다.
 * 최초 마운트 시에도 1회 동기화한다(연결 직후 진실값 확보).
 */
export function useBadgeResync(socket: Socket | null): void {
  const replaceAll = useBadgeStore((s) => s.replaceAll);
  const ctrlRef = useRef<BadgeResyncController | null>(null);

  useEffect(() => {
    const ctrl = new BadgeResyncController({
      fetcher: () =>
        apiRequest<BadgeResyncResult>('/me/notification-badges').then((r) => ({
          workspaces: r.workspaces ?? [],
        })),
      onResult: (result) => replaceAll(result.workspaces),
    });
    ctrlRef.current = ctrl;

    // 탭 포커스 복귀(hidden→visible) 시 1회 동기화.
    const onVisibility = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        ctrl.request();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    // 소켓 reconnect 시 1회 동기화. socket.io-client 는 'connect'(최초+재연결)와
    // 'reconnect'(재연결 전용)를 모두 발화하므로 양쪽을 구독하되 debounce 가 1회로 합친다.
    const onConnect = (): void => ctrl.request();
    socket?.on('connect', onConnect);
    socket?.io?.on?.('reconnect', onConnect);

    // 최초 마운트 1회 동기화.
    ctrl.request();

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      socket?.off('connect', onConnect);
      socket?.io?.off?.('reconnect', onConnect);
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [socket, replaceAll]);
}
