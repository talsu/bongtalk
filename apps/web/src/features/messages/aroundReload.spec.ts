import { describe, it, expect, beforeEach } from 'vitest';
import { resolveListFetchArgs } from './useMessages';
import { lruKey, useChannelLruStore } from '../realtime/channelLru';
import { useReadState } from '../realtime/readStateStore';

/**
 * S09 (FR-RT-22): evict 된 채널 재진입 시 around=lastReadMessageId 재로드,
 * 그 외에는 최신(before) 로드로 폴백하는 fetch-인자 결정 로직 단위 테스트.
 */
describe('resolveListFetchArgs (FR-RT-22 around-reload)', () => {
  beforeEach(() => {
    useChannelLruStore.setState({ order: [], pendingAround: new Set<string>() });
    useReadState.setState({ lastReadByChannel: {} });
  });

  it('evict 이력 없는 초기 로드 → before(최신) 로드', () => {
    const args = resolveListFetchArgs('ws-1', 'ch-1', undefined);
    expect(args).toEqual({ limit: 50, before: undefined });
  });

  it('evict 된 채널 + lastRead 보유 → around 재로드', () => {
    const key = lruKey('ws-1', 'ch-1');
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    useReadState.getState().setLastRead('ch-1', 'm-42');
    const args = resolveListFetchArgs('ws-1', 'ch-1', undefined);
    expect(args).toEqual({ limit: 50, around: 'm-42' });
    // 1회성 소비 후 두 번째 호출은 around 없이 폴백.
    const args2 = resolveListFetchArgs('ws-1', 'ch-1', undefined);
    expect(args2).toEqual({ limit: 50, before: undefined });
  });

  it('evict 됐지만 lastRead 미보유 → 최신 로드로 폴백(과설계 방지)', () => {
    const key = lruKey('ws-1', 'ch-1');
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    const args = resolveListFetchArgs('ws-1', 'ch-1', undefined);
    expect(args).toEqual({ limit: 50, before: undefined });
  });

  it('older-page fetch(pageParam 존재)는 evict 여부와 무관하게 before 커서', () => {
    const key = lruKey('ws-1', 'ch-1');
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    useReadState.getState().setLastRead('ch-1', 'm-42');
    const args = resolveListFetchArgs('ws-1', 'ch-1', 'cursor-abc');
    expect(args).toEqual({ limit: 50, before: 'cursor-abc' });
  });

  it('DM(wsId=null) 도 동일 키 규칙으로 동작', () => {
    const key = lruKey(null, 'dm-1');
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    useReadState.getState().setLastRead('dm-1', 'm-7');
    const args = resolveListFetchArgs(null, 'dm-1', undefined);
    expect(args).toEqual({ limit: 50, around: 'm-7' });
  });

  // S30 fix-forward (BLOCKER 기능 M2): 검색 점프(`?msg=`)가 around anchor 로
  // lastRead 복원보다 우선한다.
  describe('M2 ?msg= 점프 anchor 우선', () => {
    it('jumpMessageId 가 있으면 초기 로드를 그 id 의 around 로 잡는다', () => {
      const args = resolveListFetchArgs('ws-1', 'ch-1', undefined, 'jump-99');
      expect(args).toEqual({ limit: 50, around: 'jump-99' });
    });

    it('jumpMessageId 는 lastRead 복원(evict around)보다 우선한다', () => {
      const key = lruKey('ws-1', 'ch-1');
      useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
      useReadState.getState().setLastRead('ch-1', 'm-42');
      const args = resolveListFetchArgs('ws-1', 'ch-1', undefined, 'jump-99');
      expect(args).toEqual({ limit: 50, around: 'jump-99' });
      // 점프가 around 를 점유했으므로 LRU 플래그는 소비되지 않고 남아 있다.
      expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(true);
    });

    it('older-page fetch(pageParam 존재)는 jumpMessageId 가 있어도 before 커서', () => {
      const args = resolveListFetchArgs('ws-1', 'ch-1', 'cursor-abc', 'jump-99');
      expect(args).toEqual({ limit: 50, before: 'cursor-abc' });
    });
  });
});
