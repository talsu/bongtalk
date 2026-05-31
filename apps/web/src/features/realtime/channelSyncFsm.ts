/**
 * S10 (FR-RT-07): 채널 단위 재연결 동기화 FSM — 순수 로직.
 *
 * 전이도:
 *   DISCONNECTED ──connect──▶ RECONNECTING
 *   RECONNECTING ──gapNeeded──▶ GAP_FETCHING        (replay.truncated 또는 seq hole)
 *   RECONNECTING ──replayComplete──▶ SYNCED          (짧은 재연결, replay 버퍼가 커버)
 *   GAP_FETCHING ──synced──▶ SYNCED                  (gap-fetch 완료, pending flush 후)
 *   GAP_FETCHING ──failed──▶ SYNC_FAILED             (3회 연속 실패)
 *   SYNC_FAILED  ──retry──▶ GAP_FETCHING             (사용자/백오프 재시도)
 *   (any)        ──disconnect──▶ DISCONNECTED
 *   (any)        ──seqHole──▶ GAP_FETCHING           (SYNCED 중에도 hole 감지 시 재진입)
 *
 * replay-vs-gap-fetch 공존: 서버-push replay(x-last-event-id)가 우선입니다.
 * 짧은 재연결이면 서버가 replay.complete 를 보내 RECONNECTING → SYNCED 로
 * 곧장 넘어갑니다. 버퍼 미스(replay.truncated)거나 seq hole 이 감지될 때만
 * GAP_FETCHING 으로 진입해 클라-pull gap-fetch 를 수행합니다.
 *
 * 이 모듈은 상태와 전이 유효성만 책임집니다. 실제 REST 호출/버퍼 flush/토스트는
 * 호출자(useChannelSync)가 전이 결과를 보고 수행합니다.
 */

export type ChannelSyncState =
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'GAP_FETCHING'
  | 'SYNCED'
  | 'SYNC_FAILED';

export type ChannelSyncEvent =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'replayComplete' }
  | { type: 'gapNeeded' }
  | { type: 'seqHole' }
  | { type: 'synced' }
  | { type: 'failed' }
  | { type: 'retry' };

/**
 * 순수 전이 함수. 정의되지 않은 전이는 현재 상태를 그대로 유지(no-op)합니다 —
 * 동일 이벤트 중복 수신/경합 상황에서 상태가 튀지 않도록 방어적입니다.
 */
export function transition(state: ChannelSyncState, event: ChannelSyncEvent): ChannelSyncState {
  // disconnect 는 어느 상태에서든 즉시 DISCONNECTED 로.
  if (event.type === 'disconnect') return 'DISCONNECTED';

  switch (state) {
    case 'DISCONNECTED':
      return event.type === 'connect' ? 'RECONNECTING' : state;

    case 'RECONNECTING':
      if (event.type === 'gapNeeded' || event.type === 'seqHole') return 'GAP_FETCHING';
      if (event.type === 'replayComplete') return 'SYNCED';
      return state;

    case 'GAP_FETCHING':
      if (event.type === 'synced') return 'SYNCED';
      if (event.type === 'failed') return 'SYNC_FAILED';
      // 이미 fetch 중인데 hole/gapNeeded 가 더 와도 GAP_FETCHING 유지(재진입 무의미).
      return state;

    case 'SYNCED':
      // 정상 운영 중 hole 감지 → 다시 gap-fetch.
      if (event.type === 'seqHole' || event.type === 'gapNeeded') return 'GAP_FETCHING';
      // 새 connect(예: 재연결 사이클) → RECONNECTING 으로 되돌림.
      if (event.type === 'connect') return 'RECONNECTING';
      return state;

    case 'SYNC_FAILED':
      if (event.type === 'retry') return 'GAP_FETCHING';
      if (event.type === 'connect') return 'RECONNECTING';
      return state;

    default:
      return state;
  }
}

/** GAP_FETCHING 중에는 수신 WS 이벤트를 버퍼링해야 함을 알려주는 헬퍼. */
export function shouldBufferIncoming(state: ChannelSyncState): boolean {
  return state === 'GAP_FETCHING';
}
