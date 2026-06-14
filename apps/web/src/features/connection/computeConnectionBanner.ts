import type { RealtimeStatus } from '../realtime/useRealtimeConnection';

/**
 * task-040 R3: derive the user-visible connection-banner state from
 * the navigator.onLine flag (raw OS-level network) plus the realtime
 * socket status. Pure function so unit tests can assert the matrix
 * without spinning up a real socket.
 *
 * Priority: offline (network-down) wins over disconnected (socket
 * trouble) since fixing the network solves both. `connecting` shown
 * only after the first connect attempt has dropped, otherwise the
 * fresh-page bounce would flash a banner unnecessarily.
 */
// 072 백로그 S-H (N6-3): 'failed' 레벨 추가 — 자동 재연결 소진(종단). reloadable=true 면
// 배너가 "새로고침" 액션을 노출한다(일시 'disconnected'/'replaying' 는 액션 없음).
export type ConnectionBannerLevel = 'offline' | 'failed' | 'disconnected' | 'replaying';

export type ConnectionBannerState =
  | { visible: false }
  | { visible: true; level: ConnectionBannerLevel; message: string; reloadable?: boolean };

export interface ComputeArgs {
  online: boolean;
  realtimeStatus: RealtimeStatus;
  replaying: boolean;
}

export function computeConnectionBanner(args: ComputeArgs): ConnectionBannerState {
  const { online, realtimeStatus, replaying } = args;
  if (!online) {
    return {
      visible: true,
      level: 'offline',
      message: '인터넷 연결이 끊어졌습니다. 네트워크를 확인하세요.',
    };
  }
  // 072 백로그 S-H (N6-3): 재연결 소진(failed)은 일시 끊김보다 우선. 자동 복구가 끝났으므로
  // 새로고침을 안내한다(온라인인데 소켓만 종단 실패한 상태).
  if (realtimeStatus === 'failed') {
    return {
      visible: true,
      level: 'failed',
      message: '실시간 연결에 실패했습니다. 페이지를 새로고침해 주세요.',
      reloadable: true,
    };
  }
  if (realtimeStatus === 'disconnected') {
    return {
      visible: true,
      level: 'disconnected',
      message: '실시간 연결이 끊어졌습니다. 다시 연결 중…',
    };
  }
  if (replaying) {
    return {
      visible: true,
      level: 'replaying',
      message: '놓친 메시지를 가져오는 중…',
    };
  }
  return { visible: false };
}
