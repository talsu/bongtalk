import { useEffect } from 'react';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import type { ListMessagesResponse } from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';
import { listMessages } from '../messages/api';
import { useNotifications } from '../../stores/notification-store';
import { SeqTracker } from './seqTracker';
import { PendingEventBuffer, Backoff, runGapFetch } from './gapFetch';
import { GapFetchQueue } from './gapFetchQueue';
import { mergeGapMessages } from './gapMerge';
import { useChannelSyncStore } from './channelSyncStore';
import { shouldBufferIncoming } from './channelSyncFsm';
import { setActiveSeqTracker, clearActiveSeqTracker } from './seqTrackerRegistry';
import { DISPATCHED_EVENTS } from './dispatcher';

/**
 * S10 (FR-RT-06 / FR-RT-07 / FR-RT-23): 재연결 동기화 오케스트레이터.
 *
 * 설계(replay-vs-gap-fetch 공존):
 *   - 서버-push replay(x-last-event-id)가 1차 복원 경로입니다. 짧은 재연결은
 *     서버가 `replay.complete` 를 보내 곧장 SYNCED 가 됩니다(기존 동작 무회귀).
 *   - 버퍼 미스(`replay.truncated`) 또는 채널 이벤트의 seq hole 감지 시에만
 *     해당 채널을 GAP_FETCHING 으로 전환해 클라-pull gap-fetch 를 수행합니다.
 *   - GAP_FETCHING 동안 수신 WS 이벤트는 채널별 pendingEvents 버퍼에 적재합니다.
 *     단, dispatcher 는 본 sync 와 독립된 소켓 리스너로 같은 이벤트를 이미
 *     **id 멱등(FR-RT-24 dedup)** 으로 캐시에 반영합니다. 따라서 버퍼는
 *     (1) FSM 정합(완료 시점 인지)과 (2) PENDING_EVENTS_MAX 초과 감지(→ truncated
 *     + 안내 토스트)를 위한 신호이며, flush 는 이미 dispatcher 가 적용한 이벤트의
 *     **재적용을 하지 않습니다**(이중 적용 방지). gap-fetch 머지 역시 id Set
 *     dedup 이라 두 경로가 동일 캐시 상태로 수렴합니다.
 *
 * 순수 로직(hole 감지/FSM 전이/dedup 머지/FIFO 동시성/백오프)은 각 단위 모듈에
 * 있고, 여기서는 소켓 이벤트 → 그 모듈 호출 → React Query 캐시 반영의 글루만
 * 담당합니다.
 *
 * 이벤트명 단일출처(콜론 vs 닷) 불일치는 본 슬라이스 범위 밖이라, 라이브
 * 와이어의 닷 표기 이벤트(message.created 등)와 seq 필드를 그대로 사용합니다.
 */

type SyncCtx = {
  /** 채널의 (wsId, channelId) 결정 — 메시지 목록 query 키와 gap-fetch 라우팅용. */
  resolveChannelRoute: (channelId: string) => { wsId: string | null } | null;
};

const noopCtx: SyncCtx = { resolveChannelRoute: () => null };

/** 라이브 와이어에서 seq + channelId 를 안전 추출(점 표기 이벤트 페이로드). */
function readChannelEvent(payload: unknown): { channelId: string; seq: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const channelId =
    typeof p.channelId === 'string'
      ? p.channelId
      : typeof (p.message as { channelId?: unknown })?.channelId === 'string'
        ? (p.message as { channelId: string }).channelId
        : null;
  if (!channelId) return null;
  // seq 가 없으면(구 빌드) 추적 대상이 아님 — null 로 skip.
  const seq = typeof p.seq === 'number' ? p.seq : null;
  if (seq === null) return null;
  return { channelId, seq };
}

/**
 * 한 채널의 gap-fetch 1회를 수행하고 캐시에 병합 + pending 버퍼 정리 + truncated
 * 보고까지 처리합니다. 백오프/재시도는 호출부(installChannelSync)가 관리합니다.
 */
async function syncChannelOnce(args: {
  qc: QueryClient;
  wsId: string | null;
  channelId: string;
  pending: PendingEventBuffer;
}): Promise<void> {
  const { qc, wsId, channelId, pending } = args;
  const listKey = qk.messages.list(wsId ?? 'global', channelId);
  const cached = qc.getQueryData<InfiniteData<ListMessagesResponse>>(listKey);
  // 첫 페이지(가장 최신)의 prevCursor 가 "현재 보유한 가장 새 메시지" 를 가리키므로
  // 그 이후(after)부터 gap-fetch 합니다. 커서가 없으면(빈 캐시) gap-fetch 불필요.
  const after = cached?.pages[0]?.pageInfo.prevCursor ?? null;

  if (after !== null) {
    const result = await runGapFetch(
      (cursor) => listMessages(wsId, channelId, { limit: 50, after: cursor }),
      after,
      (page) => page.pageInfo.prevCursor,
    );
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(listKey, (old) =>
      mergeGapMessages(old, result.messages),
    );
    if (result.truncated) {
      useChannelSyncStore.getState().setTruncated(channelId, true);
    }
  }

  // pending 버퍼 정리. 버퍼에 쌓인 이벤트는 dispatcher 가 이미 멱등 적용했으므로
  // 재적용하지 않고 비웁니다(이중 적용 방지). 단, 초과(overflow)가 있었다면
  // 일부 신규 메시지가 누락됐을 수 있어 truncated + 안내 토스트로 알립니다.
  const overflowed = pending.didOverflow;
  pending.drain();
  if (overflowed) {
    useChannelSyncStore.getState().setTruncated(channelId, true);
    useNotifications.getState().push({
      variant: 'warning',
      title: '동기화 일부 누락',
      body: '오프라인 중 메시지가 많아 일부만 동기화했습니다. 새로고침하면 전체를 불러옵니다.',
      ttlMs: 6000,
    });
  }
}

/**
 * 소켓에 동기화 오케스트레이션을 설치합니다. detach 함수를 반환합니다.
 * useRealtimeConnection 이 dispatcher 설치와 동일 생명주기로 호출합니다.
 *
 * `dispatchEvent` 는 버퍼 flush 시 dispatcher 핸들러를 재호출하기 위한 콜백입니다.
 */
export function installChannelSync(
  socket: Socket,
  qc: QueryClient,
  ctx: SyncCtx = noopCtx,
): () => void {
  const store = useChannelSyncStore.getState();
  const seq = new SeqTracker();
  // FIX #5: LRU evict 경로(runChannelLruEntry)가 이 tracker 의 채널을 reset
  // 할 수 있도록 활성 인스턴스로 등록합니다.
  setActiveSeqTracker(seq);
  const queue = new GapFetchQueue();
  const pendingByChannel = new Map<string, PendingEventBuffer>();
  const backoffByChannel = new Map<string, Backoff>();
  const detachers: Array<() => void> = [];

  const pendingFor = (channelId: string): PendingEventBuffer => {
    let buf = pendingByChannel.get(channelId);
    if (!buf) {
      buf = new PendingEventBuffer();
      pendingByChannel.set(channelId, buf);
    }
    return buf;
  };

  const backoffFor = (channelId: string): Backoff => {
    let b = backoffByChannel.get(channelId);
    if (!b) {
      b = new Backoff();
      backoffByChannel.set(channelId, b);
    }
    return b;
  };

  const runSync = (channelId: string): void => {
    const route = ctx.resolveChannelRoute(channelId);
    if (!route) {
      // 라우트 미상 → gap-fetch 불가, 그냥 SYNCED 로 종료하고 버퍼 비움.
      store.dispatch(channelId, { type: 'synced' });
      pendingFor(channelId).drain();
      return;
    }
    void queue
      .enqueue(channelId, () =>
        syncChannelOnce({
          qc,
          wsId: route.wsId,
          channelId,
          pending: pendingFor(channelId),
        }),
      )
      .then(
        () => {
          backoffFor(channelId).reset();
          store.dispatch(channelId, { type: 'synced' });
        },
        () => {
          // MED fix (S10 review): 한 번의 실패는 attempt 를 정확히 1만 소진해야
          // 합니다. 예전엔 nextDelay() 를 두 번(소진 판정 전 1회 + 재시도 지연
          // 계산 1회) 호출해 실패당 attempt 가 2씩 늘어 3회 한도를 절반의
          // 실패로 빨리 태웠습니다. 이제 delay 를 1회만 계산해 그 값을 재사용
          // 하고, exhausted 는 그 1회 증가 *이후* 상태로 판정합니다.
          const b = backoffFor(channelId);
          const delay = b.nextDelay();
          if (b.exhausted) {
            store.dispatch(channelId, { type: 'failed' });
            useNotifications.getState().push({
              variant: 'danger',
              title: '동기화 실패',
              body: '메시지 동기화에 반복 실패했습니다. 다시 시도해 주세요.',
              ttlMs: 8000,
            });
          } else {
            // 백오프 후 재시도 — SYNC_FAILED 로 가지 않고 GAP_FETCHING 유지.
            setTimeout(() => runSync(channelId), delay);
          }
        },
      );
  };

  const enterGapFetch = (channelId: string, reason: 'gapNeeded' | 'seqHole'): void => {
    const next = store.dispatch(channelId, { type: reason });
    if (next === 'GAP_FETCHING') {
      backoffFor(channelId).reset();
      runSync(channelId);
    }
  };

  // ----- 소켓 이벤트 배선 -----

  const onConnect = (): void => {
    // 재연결: 추적 중인 모든 채널을 RECONNECTING 으로. socket.recovered 는
    // 무시(요구사항) — engine.io 의 무손실 복구와 무관하게 우리 FSM 을 돌립니다.
    for (const channelId of seqTrackedChannels(seq)) {
      store.dispatch(channelId, { type: 'connect' });
    }
  };
  socket.on('connect', onConnect);
  detachers.push(() => socket.off('connect', onConnect));

  const onDisconnect = (): void => {
    for (const channelId of seqTrackedChannels(seq)) {
      store.dispatch(channelId, { type: 'disconnect' });
    }
  };
  socket.on('disconnect', onDisconnect);
  detachers.push(() => socket.off('disconnect', onDisconnect));

  // S10 fix-forward (MAJOR #2): connect 직후 서버가 채널별 seq baseline 을
  // `channel:joined` 로 내려줍니다. setBaseline 으로 SeqTracker 에 채널을
  // 등록해, 이번 세션에 라이브 메시지가 없던 채널도 재연결 시 gap-fetch/
  // FSM 전이 대상(seqTrackedChannels)에 포함되도록 합니다(no-op FSM 해소).
  const onChannelJoined = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { channelId?: unknown; seq?: unknown };
    if (typeof p.channelId !== 'string' || typeof p.seq !== 'number') return;
    seq.setBaseline(p.channelId, p.seq);
  };
  socket.on('channel:joined', onChannelJoined);
  detachers.push(() => socket.off('channel:joined', onChannelJoined));

  const onReplayComplete = (): void => {
    // 버퍼가 짧은 재연결을 커버 → 추적 채널을 SYNCED 로(RECONNECTING 한정 전이).
    for (const channelId of seqTrackedChannels(seq)) {
      store.dispatch(channelId, { type: 'replayComplete' });
    }
  };
  socket.on('replay.complete', onReplayComplete);
  detachers.push(() => socket.off('replay.complete', onReplayComplete));

  const onReplayTruncated = (payload: unknown): void => {
    // S10 fix-forward (MAJOR #3): 서버가 truncated 된 channelIds 를 실어 보냅니다.
    // 해당 채널만 gap-fetch 해 한 채널 버퍼 미스가 N채널 gap-fetch 로 번지지
    // 않게 합니다. 구 서버(channelIds 없는 payload) 호환: 목록이 없으면 기존
    // 동작(추적 중 전체 gap-fetch)으로 폴백합니다.
    const channelIds =
      payload &&
      typeof payload === 'object' &&
      Array.isArray((payload as { channelIds?: unknown }).channelIds)
        ? (payload as { channelIds: unknown[] }).channelIds.filter(
            (c): c is string => typeof c === 'string',
          )
        : null;
    const targets = channelIds ?? seqTrackedChannels(seq);
    for (const channelId of targets) {
      enterGapFetch(channelId, 'gapNeeded');
    }
  };
  socket.on('replay.truncated', onReplayTruncated);
  detachers.push(() => socket.off('replay.truncated', onReplayTruncated));

  // 채널 스코프 이벤트마다 seq 관찰 + GAP_FETCHING 중이면 버퍼링.
  const onChannelEvent = (event: string) => (payload: unknown) => {
    const info = readChannelEvent(payload);
    if (!info) return;
    const state = store.get(info.channelId);
    if (shouldBufferIncoming(state)) {
      // GAP_FETCHING 중: 정상 dispatcher 적용 대신 버퍼에 적재(완료 후 flush).
      pendingFor(info.channelId).push(event, payload);
      return;
    }
    const obs = seq.observe(info.channelId, info.seq);
    // seq=-1(sentinel) → hole 판정 skip(루프 방지). 재연결 후 1회 gap-fetch 는
    // replay.truncated 경로가 담당하므로 여기서는 추가 동작 없음.
    if (obs.kind === 'hole') {
      enterGapFetch(info.channelId, 'seqHole');
    }
  };

  for (const event of DISPATCHED_EVENTS) {
    const handler = onChannelEvent(event);
    socket.on(event, handler);
    detachers.push(() => socket.off(event, handler));
  }

  return () => {
    for (const d of detachers) d();
    clearActiveSeqTracker(seq);
    seq.clear();
  };
}

/** SeqTracker 내부에 추적 채널 목록을 노출하는 헬퍼(테스트/내부용). */
function seqTrackedChannels(tracker: SeqTracker): string[] {
  return tracker.channels();
}

/**
 * Shell 루트에서 한 번 설치하는 훅 래퍼. 실제 배선은 useRealtimeConnection 이
 * installChannelSync 를 직접 호출하므로, 단독 사용 시에만 쓰입니다.
 */
export function useChannelSync(socket: Socket | null, ctx?: SyncCtx): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!socket) return;
    return installChannelSync(socket, qc, ctx);
  }, [socket, qc, ctx]);
}
