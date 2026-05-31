import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS, type UserUnblockedPayload } from '@qufox/shared-types';
import { getSocket } from '../../lib/socket';

/**
 * S17 (FR-DM-19): `user:unblocked` 소켓 이벤트 소비. 차단을 해제하면 서버가
 * blocker 본인의 user:{userId} 룸으로 push 하고, 이 훅이 현재 열린 채널들의
 * 메시지 캐시를 무효화해 차단 해제된 사용자의 메시지 마스킹(`[차단된
 * 사용자의 메시지]`)이 풀린 본문으로 재로드되게 한다.
 *
 * `useDmCreated` 와 동일한 패턴: 중앙 dispatcher 가 아니라 DM 피처 안에 두어
 * 응집도를 높이고, Shell 이 mount 시 opt-in 한다. 메시지 캐시는 (wsId, chId)
 * 별로 쪼개져 있으나 어느 채널에 차단 사용자 메시지가 있는지 클라가 모르므로
 * 메시지 리스트 전체 prefix(['messages'])를 무효화한다 — 차단 해제는 드물어
 * 과도한 비용이 아니다.
 *
 * 주의(carryover): 이 훅은 현재 어떤 Shell 에도 배선돼 있지 않다(dormant).
 * useDmCreated/신규 훅 Shell 배선은 별도 작업으로 이관됐다(DEFER).
 */
export function useUserUnblocked(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (_env: UserUnblockedPayload): void => {
      // 메시지 리스트 전체 무효화 — 차단 해제된 사용자의 마스킹된 메시지를
      // 풀린 본문으로 재로드한다. 부분 키 매치로 workspace + global DM 채널을
      // 함께 갱신한다.
      void qc.invalidateQueries({ queryKey: ['messages'] });
    };
    socket.on(WS_EVENTS.USER_UNBLOCKED, handler);
    return () => {
      socket.off(WS_EVENTS.USER_UNBLOCKED, handler);
    };
  }, [qc]);
}
