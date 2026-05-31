import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { qk } from '../../lib/query-keys';
import { touchChannel } from '../messages/channelLruCache';

/**
 * S09 (FR-RT-22): 채널 메시지 목록 LRU 캐시 — React Query 부수효과 계층.
 *
 * 순수 LRU 정책(진입 순서 → eviction 대상 산출)은 messages/channelLruCache.ts
 * 의 `touchChannel` 가 담당합니다. 여기서는 그 결과를 받아
 *   1. zustand 로 LRU 순서를 보관하고,
 *   2. evict 된 채널의 메시지 목록 query 를 `qc.removeQueries` 로 제거하며,
 *   3. evict 된 채널을 `pendingAround` 집합에 넣어(재진입 시 around 재로드
 *      신호) 둡니다.
 *
 * 채널 키는 `qk.messages.list(wsId, chId)` 와 동일한 식별을 위해
 * "wsId::chId" 합성 문자열을 씁니다(DM 은 wsId='global').
 */

/** LRU 키 합성 — query-keys 의 messages.list 와 1:1 대응. */
export function lruKey(wsId: string | null, channelId: string): string {
  return `${wsId ?? 'global'}::${channelId}`;
}

function splitLruKey(key: string): { wsId: string; channelId: string } {
  const idx = key.indexOf('::');
  return { wsId: key.slice(0, idx), channelId: key.slice(idx + 2) };
}

/** 환경변수 override 를 반영한 캐시 상한(기본 5). */
export function channelCacheSize(): number {
  const raw = import.meta.env?.VITE_CHANNEL_CACHE_SIZE as string | undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.floor(n);
}

type ChannelLruState = {
  order: string[];
  /**
   * 한 번이라도 evict 되어 재진입 시 around 재로드가 필요한 채널 키 집합.
   * 재진입해 around 로드를 소비하면(consumeAround) 제거됩니다.
   */
  pendingAround: Set<string>;
  /**
   * 채널 진입을 기록하고, 상한 초과 시 evict 대상 키 목록을 반환합니다.
   * (실제 removeQueries 는 훅이 수행합니다.)
   */
  enter: (key: string, maxSize: number) => string[];
  /** 재진입 시 around 재로드가 필요한지 — true 면 플래그를 소비(제거)합니다. */
  consumeAround: (key: string) => boolean;
};

export const useChannelLruStore = create<ChannelLruState>((set, get) => ({
  order: [],
  pendingAround: new Set<string>(),
  enter: (key, maxSize) => {
    const { order, evicted } = touchChannel(get().order, key, maxSize);
    if (evicted.length === 0) {
      // 순서만 갱신.
      set({ order });
      return [];
    }
    const pendingAround = new Set(get().pendingAround);
    for (const k of evicted) pendingAround.add(k);
    set({ order, pendingAround });
    return evicted;
  },
  consumeAround: (key) => {
    const { pendingAround } = get();
    if (!pendingAround.has(key)) return false;
    const next = new Set(pendingAround);
    next.delete(key);
    set({ pendingAround: next });
    return true;
  },
}));

/**
 * 채널 진입을 LRU 에 기록하고, 상한 초과로 밀려난 채널의 메시지 목록
 * 캐시를 `qc.removeQueries` 로 제거합니다. 훅과 단위 테스트가 공유하는
 * 단일 출처(테스트 drift 방지). React 의존이 없어 QueryClient 만 있으면
 * 직접 호출/검증할 수 있습니다.
 *
 * NOTE(S10): GAP_FETCHING reset 하위요건(FR-RT-06/07 FSM)은 본 슬라이스
 * 범위 밖입니다. evict/재진입 시 진행 중 GAP 복구 상태를 리셋해야 하지만
 * FSM 이 아직 없어 여기서는 seam 만 둡니다 — FSM 도입(S10) 시 아래 evict
 * 루프에 GAP 리셋을 연결합니다.
 */
export function runChannelLruEntry(
  qc: QueryClient,
  wsId: string | null,
  channelId: string,
  maxSize: number,
): string[] {
  const key = lruKey(wsId, channelId);
  const evicted = useChannelLruStore.getState().enter(key, maxSize);
  const cache = qc.getQueryCache();
  for (const k of evicted) {
    const { wsId: ws, channelId: ch } = splitLruKey(k);
    // qk.messages.list 는 wsId='global' sentinel 을 그대로 받습니다.
    const queryKey = qk.messages.list(ws, ch);
    // review(perf SERIOUS): removeQueries 는 활성 observer 가 있어도 강제
    // 삭제하므로, 마운트된 채널(예: 향후 split-view/thread 통합)이 evict 되면
    // 즉시 refetch 폭주가 난다. 관찰자가 없을 때만 제거해 "미사용 채널만 evict"
    // 불변식을 지킨다(현 단일 컬럼에서도 Concurrent 타이밍 방어). 관찰 중이면
    // gcTime 자연 만료에 맡긴다.
    const observed = (cache.find({ queryKey })?.getObserversCount() ?? 0) > 0;
    if (!observed) qc.removeQueries({ queryKey });
    // TODO(S10): FSM 도입 시 여기서 evict 된 채널의 GAP_FETCHING 상태를 리셋.
  }
  return evicted;
}

/**
 * 채널 진입(전환) 시 호출하는 훅. MessageList 가 마운트/channelId 변경마다
 * 호출합니다. 실제 LRU/eviction 로직은 runChannelLruEntry 가 담당합니다.
 */
export function useChannelLru(wsId: string | null, channelId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!channelId) return;
    runChannelLruEntry(qc, wsId, channelId, channelCacheSize());
  }, [wsId, channelId, qc]);
}
