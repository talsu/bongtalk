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
export type ConnectionBannerState =
  | { visible: false }
  | { visible: true; level: 'offline' | 'disconnected' | 'replaying'; message: string };

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
