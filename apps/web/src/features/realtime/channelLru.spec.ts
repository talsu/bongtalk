import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';
import { lruKey, channelCacheSize, useChannelLruStore, runChannelLruEntry } from './channelLru';

/**
 * S09 (FR-RT-22): LRU 부수효과 계층(zustand store + removeQueries) 단위 테스트.
 * 순수 정책은 messages/channelLruCache.spec.ts 가 별도로 커버합니다.
 */

function reset(): void {
  useChannelLruStore.setState({ order: [], pendingAround: new Set<string>() });
}

describe('channelCacheSize (FR-RT-22 env override)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('env 미설정이면 기본값 5', () => {
    // import.meta.env.VITE_CHANNEL_CACHE_SIZE 미설정 환경.
    expect(channelCacheSize()).toBe(5);
  });
});

describe('lruKey', () => {
  it('wsId=null 은 global sentinel 로 합성', () => {
    expect(lruKey(null, 'ch-1')).toBe('global::ch-1');
    expect(lruKey('ws-1', 'ch-1')).toBe('ws-1::ch-1');
  });
});

describe('useChannelLruStore.enter (FR-RT-22)', () => {
  beforeEach(() => {
    reset();
  });

  it('상한 미만이면 evict 없음', () => {
    expect(useChannelLruStore.getState().enter('a', 3)).toEqual([]);
    expect(useChannelLruStore.getState().enter('b', 3)).toEqual([]);
    expect(useChannelLruStore.getState().order).toEqual(['a', 'b']);
  });

  it('상한 초과 시 head 를 evict 하고 pendingAround 에 등록', () => {
    for (const k of ['a', 'b', 'c']) useChannelLruStore.getState().enter(k, 3);
    const evicted = useChannelLruStore.getState().enter('d', 3);
    expect(evicted).toEqual(['a']);
    expect(useChannelLruStore.getState().pendingAround.has('a')).toBe(true);
  });

  it('consumeAround 는 1회성(소비 후 false)', () => {
    for (const k of ['a', 'b', 'c']) useChannelLruStore.getState().enter(k, 3);
    useChannelLruStore.getState().enter('d', 3); // a evict
    expect(useChannelLruStore.getState().consumeAround('a')).toBe(true);
    expect(useChannelLruStore.getState().consumeAround('a')).toBe(false);
  });
});

describe('runChannelLruEntry → removeQueries on eviction (FR-RT-22)', () => {
  beforeEach(() => {
    reset();
  });

  it('상한 3 초과 4번째 채널 진입 시 가장 오래된 채널 query 제거', () => {
    const qc = new QueryClient();
    const channels = ['c1', 'c2', 'c3', 'c4'];
    for (const ch of channels) {
      qc.setQueryData(qk.messages.list('ws-1', ch), {
        pages: [{ items: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }],
        pageParams: [undefined],
      });
    }
    // 채널을 순서대로 진입.
    for (const ch of channels) runChannelLruEntry(qc, 'ws-1', ch, 3);
    // c4 진입으로 c1 evict → c1 캐시 제거, 나머지 유지.
    expect(qc.getQueryData(qk.messages.list('ws-1', 'c1'))).toBeUndefined();
    expect(qc.getQueryData(qk.messages.list('ws-1', 'c2'))).toBeDefined();
    expect(qc.getQueryData(qk.messages.list('ws-1', 'c4'))).toBeDefined();
    // evict 된 c1 은 재진입 시 around 재로드 대상.
    expect(useChannelLruStore.getState().consumeAround(lruKey('ws-1', 'c1'))).toBe(true);
  });

  it('재진입으로 recency 갱신된 채널은 evict 대상이 아니다', () => {
    const qc = new QueryClient();
    for (const ch of ['c1', 'c2', 'c3']) {
      qc.setQueryData(qk.messages.list('ws-1', ch), { pages: [], pageParams: [] });
    }
    for (const ch of ['c1', 'c2', 'c3']) runChannelLruEntry(qc, 'ws-1', ch, 3);
    runChannelLruEntry(qc, 'ws-1', 'c1', 3); // c1 → most-recent
    qc.setQueryData(qk.messages.list('ws-1', 'c4'), { pages: [], pageParams: [] });
    const evicted = runChannelLruEntry(qc, 'ws-1', 'c4', 3); // head=c2 evict
    expect(evicted).toEqual([lruKey('ws-1', 'c2')]);
    expect(qc.getQueryData(qk.messages.list('ws-1', 'c1'))).toBeDefined();
    expect(qc.getQueryData(qk.messages.list('ws-1', 'c2'))).toBeUndefined();
  });
});
