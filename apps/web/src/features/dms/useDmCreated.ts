import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS, type DmCreatedPayload } from '@qufox/shared-types';
import { getSocket } from '../../lib/socket';

/**
 * S16 (FR-DM-16): `dm:created` 소켓 이벤트 소비. 새 DM·그룹 DM 이 개설되면
 * 서버가 참여자의 user:{userId} 룸으로 push 하고, 이 훅이 DM 목록 캐시를
 * 무효화해 사이드바가 즉시 새 대화를 띄운다.
 *
 * 중앙 dispatcher(features/realtime)가 아니라 DM 피처 안에 두는 이유: DM
 * 스코프 캐시 키만 다루므로 응집도가 높고, dispatcher 를 수정하지 않고도
 * DM Shell 이 mount 시 opt-in 할 수 있다. 싱글톤 소켓에 직접 붙되 언마운트 시
 * 반드시 off 한다(리스너 누수 방지).
 */
export function useDmCreated(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (env: DmCreatedPayload): void => {
      // 서버 랭킹(lastMessageAt desc + unreadCount)을 단일 출처로 두고 목록만
      // 무효화한다. 부분 키 매치로 global + workspace-scoped 항목을 함께 갱신.
      // isGroup 에 따라 1:1(['dm','list']) / 그룹(['dm','groups']) 목록을 갱신.
      if (env.isGroup) {
        void qc.invalidateQueries({ queryKey: ['dm', 'groups'] });
      } else {
        void qc.invalidateQueries({ queryKey: ['dm', 'list'] });
      }
    };
    socket.on(WS_EVENTS.DM_CREATED, handler);
    return () => {
      socket.off(WS_EVENTS.DM_CREATED, handler);
    };
  }, [qc]);
}
