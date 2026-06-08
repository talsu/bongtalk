import { describe, it, expect, beforeEach } from 'vitest';
import { resolveListFetchArgs, clearAroundFlagOnSuccess } from './useMessages';
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
  });

  // S97 (HIGH-2): resolveListFetchArgs 는 peek 라 소비하지 않는다 — queryFn 이
  // network 실패로 retry 될 때 같은 around 가 재계산돼야 한다. 플래그 clear 는
  // queryFn 성공 후(useMessageHistory)에서만 일어난다.
  it('HIGH-2: 같은 인자 재호출(retry)에도 around 보존(플래그 미소진)', () => {
    const key = lruKey('ws-1', 'ch-1');
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    useReadState.getState().setLastRead('ch-1', 'm-42');
    expect(resolveListFetchArgs('ws-1', 'ch-1', undefined)).toEqual({ limit: 50, around: 'm-42' });
    // retry 가정: 두 번째 호출도 동일 around(소비 안 됨).
    expect(resolveListFetchArgs('ws-1', 'ch-1', undefined)).toEqual({ limit: 50, around: 'm-42' });
    expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(true);
  });

  // S97 (MED-1): lastRead 가 아직 미공급(channel:joined race)이면 around 를 쓰지
  // 않고 before 폴백하되, 플래그는 소진하지 않는다(peek). lastRead 도착 후 다음
  // fetch 에서 around 가 적용된다.
  it('MED-1: lastRead 미공급(race) 시 before 폴백 + 플래그 보존, 도착 후 around 적용', () => {
    const key = lruKey('ws-1', 'ch-1');
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    // lastRead 아직 없음.
    expect(resolveListFetchArgs('ws-1', 'ch-1', undefined)).toEqual({
      limit: 50,
      before: undefined,
    });
    // 플래그 미소진(다음 기회 유지).
    expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(true);
    // lastRead 가 channel:joined 로 도착하면 다음 fetch 에서 around 적용.
    useReadState.getState().setLastRead('ch-1', 'm-42');
    expect(resolveListFetchArgs('ws-1', 'ch-1', undefined)).toEqual({ limit: 50, around: 'm-42' });
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

// S97 (FR-RT-22 하드닝): clearAroundFlagOnSuccess — fetch 성공 후에만 플래그를
// 비우는 결정 로직(queryFn 의 await 성공 분기와 동일 출처).
describe('clearAroundFlagOnSuccess (FR-RT-22 onSuccess clear)', () => {
  const key = lruKey('ws-1', 'ch-1');
  beforeEach(() => {
    useChannelLruStore.setState({ order: [], pendingAround: new Set([key]) });
    useReadState.setState({ lastReadByChannel: {} });
  });

  it('초기 로드 + around 적용됨 → 플래그 clear(성공 1회)', () => {
    clearAroundFlagOnSuccess('ws-1', 'ch-1', undefined, null, { limit: 50, around: 'm-42' });
    expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(false);
  });

  it('MED-1: around 미적용(before 폴백) → 플래그 보존(clear 안 함)', () => {
    clearAroundFlagOnSuccess('ws-1', 'ch-1', undefined, null, { limit: 50, before: undefined });
    expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(true);
  });

  it('older-page fetch(pageParam 존재) → 플래그 보존(clear 안 함)', () => {
    clearAroundFlagOnSuccess('ws-1', 'ch-1', 'cursor-abc', null, {
      limit: 50,
      before: 'cursor-abc',
    });
    expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(true);
  });

  it('jump around(LRU 유래 아님) → LRU 플래그 보존(clear 안 함)', () => {
    clearAroundFlagOnSuccess('ws-1', 'ch-1', undefined, 'jump-99', {
      limit: 50,
      around: 'jump-99',
    });
    expect(useChannelLruStore.getState().pendingAround.has(key)).toBe(true);
  });
});
