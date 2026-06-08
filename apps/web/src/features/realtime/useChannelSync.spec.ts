// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import type { ListMessagesResponse } from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';
import { useChannelSyncStore } from './channelSyncStore';

/**
 * S99 (S10 carryover · MED): gap-fetch 재시도 setTimeout orphan 누수 회귀 가드.
 *
 * detach(로그아웃/소켓 교체) 시 보류 중인 재시도 타이머를 전부 clearTimeout 해야
 * 한다. 안 하면 detach 후에도 타이머가 살아남아 stale 클로저로 runSync(→
 * listMessages)를 발화해 401 + stray "동기화 실패" 토스트를 만든다. 또 재예약
 * 시 기존 타이머를 먼저 clear 해 채널당 1개를 유지한다.
 */

// listMessages 를 reject 시켜 gap-fetch 실패 → 재시도 경로를 강제한다.
const listMessages = vi.fn();
vi.mock('../messages/api', () => ({
  listMessages: (...args: unknown[]) => listMessages(...args),
}));

// 토스트 부수효과는 push 호출만 stub(렌더 불요).
const notifPush = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: { getState: () => ({ push: notifPush }) },
}));

import { installChannelSync } from './useChannelSync';

function makeFakeSocket(): Socket & { emit: (event: string, payload: unknown) => void } {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const socket = {
    on: (event: string, h: (e: unknown) => void) => {
      (handlers[event] ??= []).push(h);
      return socket;
    },
    off: (event: string, h: (e: unknown) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((x) => x !== h);
      return socket;
    },
    emit: (event: string, payload: unknown) => {
      for (const h of handlers[event] ?? []) h(payload);
    },
  } as unknown as Socket & { emit: (event: string, payload: unknown) => void };
  return socket;
}

const CH = 'c1';
const WS = 'w1';

function seedCache(qc: QueryClient): void {
  // 첫 페이지 prevCursor 가 비-null 이어야 syncChannelOnce 가 runGapFetch 를 탄다.
  const data: InfiniteData<ListMessagesResponse> = {
    pages: [
      {
        items: [],
        pageInfo: { prevCursor: 'cursor-0', nextCursor: null, hasMore: false },
      } as unknown as ListMessagesResponse,
    ],
    pageParams: [undefined],
  };
  qc.setQueryData(qk.messages.list(WS, CH), data);
}

/** 채널을 GAP_FETCHING 으로 진입시켜 첫 runSync(→실패)를 트리거한다. */
function enterGapFetch(socket: ReturnType<typeof makeFakeSocket>): void {
  // channel:joined → seqTracker 에 채널 등록(seqTrackedChannels 포함).
  socket.emit('channel:joined', { channelId: CH, seq: 1, lastReadMessageId: null });
  // connect → 추적 채널을 RECONNECTING 으로.
  socket.emit('connect', undefined);
  // replay.truncated(해당 채널) → gapNeeded → GAP_FETCHING → runSync.
  socket.emit('replay.truncated', { channelIds: [CH] });
}

describe('useChannelSync 재시도 타이머 orphan 방지 (S99)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
    listMessages.mockReset();
    notifPush.mockReset();
    useChannelSyncStore.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detach 가 보류 중인 재시도 타이머를 clearTimeout 한다(발화 안 함)', async () => {
    const qc = new QueryClient();
    seedCache(qc);
    listMessages.mockRejectedValue(new Error('boom'));
    const socket = makeFakeSocket();
    const detach = installChannelSync(socket, qc, { resolveChannelRoute: () => ({ wsId: WS }) });

    enterGapFetch(socket);
    // 첫 gap-fetch 실패가 처리되도록 마이크로태스크/타이머를 비운다.
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = listMessages.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // detach: 보류 중인 재시도 타이머가 전부 취소돼야 한다.
    detach();

    // 백오프 지연(첫 재시도 500ms)을 한참 넘겨도 추가 호출이 없어야 한다(orphan 미발화).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listMessages.mock.calls.length).toBe(callsAfterFirst);
  });

  it('detach 중 in-flight gap-fetch 가 reject 돼도 재시도를 부활시키지 않는다(MEDIUM-1)', async () => {
    const qc = new QueryClient();
    seedCache(qc);
    // listMessages 를 수동 제어 deferred 로 둬 detach 시점에 in-flight(미정착)
    // 상태가 되게 한다. 타이머 취소(Map)만으로는 막지 못하는 경로 — detach 이후
    // Promise 가 reject 되면 실패 콜백이 scheduleRetry 로 타이머를 부활시키려 한다.
    let rejectFetch: ((e: unknown) => void) | undefined;
    listMessages.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const socket = makeFakeSocket();
    const detach = installChannelSync(socket, qc, { resolveChannelRoute: () => ({ wsId: WS }) });

    enterGapFetch(socket);
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = listMessages.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(rejectFetch).toBeDefined();

    // detach 가 in-flight Promise 정착보다 먼저 일어난다.
    detach();
    // 이제 in-flight gap-fetch 가 reject — detached 가드가 없으면 실패 콜백이
    // scheduleRetry 로 타이머를 부활시켜 아래 advance 에서 추가 호출이 발생한다.
    rejectFetch!(new Error('boom-after-detach'));
    await vi.advanceTimersByTimeAsync(0);

    // 백오프 지연(500ms~)을 한참 넘겨도 추가 호출이 없어야 한다(재시도 미부활).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listMessages.mock.calls.length).toBe(callsAfterFirst);
    // detach 이후엔 stray "동기화 실패" 토스트도 뜨면 안 된다.
    expect(notifPush).not.toHaveBeenCalled();
  });

  it('재예약 시 기존 타이머를 clear 해 채널당 1개만 유지(중복 발화 없음)', async () => {
    const qc = new QueryClient();
    seedCache(qc);
    listMessages.mockRejectedValue(new Error('boom'));
    const socket = makeFakeSocket();
    const detach = installChannelSync(socket, qc, { resolveChannelRoute: () => ({ wsId: WS }) });

    enterGapFetch(socket);
    await vi.advanceTimersByTimeAsync(0);

    // 재시도 백오프(500 → 1000)를 흘려 재시도가 누적 발화하되, 각 실패당 정확히
    // 1회만 재시도가 잡혀야 한다(타이머 중복 누적 없음). maxAttempts(3) 도달 시
    // 자가종료하므로 호출 수는 유한하게 멈춘다.
    await vi.advanceTimersByTimeAsync(500); // 1차 재시도
    await vi.advanceTimersByTimeAsync(1000); // 2차 재시도
    await vi.advanceTimersByTimeAsync(8000); // 한도 도달 후 더 흘려도 추가 없음
    const total = listMessages.mock.calls.length;
    // 한도(3)로 자가종료 → 추가로 더 흘려도 증가 없음.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listMessages.mock.calls.length).toBe(total);

    detach();
  });
});
