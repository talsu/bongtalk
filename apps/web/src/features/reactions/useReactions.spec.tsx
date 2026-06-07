// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';

/**
 * S39 fix-forward (reviewer MAJOR ★2 — debounce 2버그):
 *   (a) 롤백 스냅샷이 첫 낙관 패치 *이후* 캡처돼 누적 델타가 섞였다.
 *   (b) 짝수 클릭(UI 상 净 no-op)도 단일 toggle POST 를 무조건 보내 서버 상태를
 *       의도와 반대로 뒤집었다.
 * 이제 useToggleReaction 은
 *   - 버스트 시작 시 1회 스냅샷을 잡아 실패 시 정확 복원,
 *   - net-intent 로 desired==preBurst(净 no-op)면 POST 미전송, 다르면 1회만 전송,
 *   - reaction-intent 모듈에 뷰어 의도를 기록(dispatcher sticky-ghost 방지)
 * 한다.
 */

const toggleReaction = vi.fn();
vi.mock('./api', () => ({
  toggleReaction: (messageId: string, emoji: string) => toggleReaction(messageId, emoji),
}));

const pushNotification = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: { getState: () => ({ push: pushNotification }) },
}));

import { useToggleReaction, REACTION_DEBOUNCE_MS } from './useReactions';
import { peekReactionIntent, __resetReactionIntents } from './reaction-intent';
import { qk } from '../../lib/query-keys';

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const WS = 'ws-1';
const CH = 'ch-1';
const MSG = 'msg-a';

function seed(qc: QueryClient, byMe: boolean, count: number): void {
  const msg: MessageDto = {
    id: MSG,
    channelId: CH,
    authorId: 'u-1',
    content: 'hi',
    contentRaw: null,
    contentAst: null,
    contentPlain: null,
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false, roles: [] },
    edited: false,
    deleted: false,
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    editedAt: null,
    reactions: count > 0 ? [{ emoji: '👍', count, byMe }] : [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
    embeds: [],
  };
  const data: InfiniteData<ListMessagesResponse> = {
    pages: [{ items: [msg], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }],
    pageParams: [undefined],
  };
  qc.setQueryData(qk.messages.list(WS, CH), data);
}

function readBucket(qc: QueryClient): { emoji: string; count: number; byMe: boolean } | undefined {
  const data = qc.getQueryData<InfiniteData<ListMessagesResponse>>(qk.messages.list(WS, CH));
  return data?.pages[0].items[0].reactions?.find((r) => r.emoji === '👍');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  toggleReaction.mockReset().mockResolvedValue({ emoji: '👍', count: 1, byMe: true });
  pushNotification.mockReset();
  __resetReactionIntents();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  __resetReactionIntents();
});

describe('useToggleReaction net-intent + rollback (S39 ★2 debounce)', () => {
  it('단일 클릭(추가): 1회 POST + 낙관 +1 + 의도 기록', async () => {
    const qc = makeClient();
    seed(qc, false, 0);
    const { result } = renderHook(() => useToggleReaction(WS, CH), { wrapper: wrapper(qc) });

    act(() => {
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: false });
    });
    // 낙관 즉시 반영.
    expect(readBucket(qc)).toEqual({ emoji: '👍', count: 1, byMe: true });
    // 의도가 기록됐다(dispatcher 가 참조).
    expect(peekReactionIntent(MSG, '👍')).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(REACTION_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(toggleReaction).toHaveBeenCalledTimes(1);
    expect(toggleReaction).toHaveBeenCalledWith(MSG, '👍');
  });

  it('짝수 클릭(净 no-op): POST 미전송, UI 원상복귀, 의도 정리', async () => {
    const qc = makeClient();
    seed(qc, false, 0);
    const { result } = renderHook(() => useToggleReaction(WS, CH), { wrapper: wrapper(qc) });

    // 더블클릭 — 추가 후 즉시 제거(같은 윈도우 안).
    act(() => {
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: false });
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: true });
    });
    // 두 번째 낙관 패치 후 count 0 → 버킷이 사라진다(원상복귀).
    expect(readBucket(qc)).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(REACTION_DEBOUNCE_MS);
      await Promise.resolve();
    });
    // 净 no-op 이라 서버에 아무것도 보내지 않는다.
    expect(toggleReaction).not.toHaveBeenCalled();
    // 합의 상태라 의도는 정리됐다.
    expect(peekReactionIntent(MSG, '👍')).toBeNull();
  });

  it('홀수 클릭(3회): 단일 toggle POST 1회만 전송', async () => {
    const qc = makeClient();
    seed(qc, false, 0);
    const { result } = renderHook(() => useToggleReaction(WS, CH), { wrapper: wrapper(qc) });

    act(() => {
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: false });
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: true });
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: false });
    });
    expect(readBucket(qc)).toEqual({ emoji: '👍', count: 1, byMe: true });

    await act(async () => {
      vi.advanceTimersByTime(REACTION_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(toggleReaction).toHaveBeenCalledTimes(1);
  });

  it('POST 실패: 버스트 시작 스냅샷으로 정확 롤백(누적 델타 없음) + 토스트 + 의도 제거', async () => {
    const qc = makeClient();
    // 시작 상태: 내가 이미 반응(byMe=true, count=3).
    seed(qc, true, 3);
    toggleReaction.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useToggleReaction(WS, CH), { wrapper: wrapper(qc) });

    // 제거 의도(홀수 클릭) — 낙관적으로 -1.
    act(() => {
      result.current.toggle({ messageId: MSG, emoji: '👍', currentlyByMe: true });
    });
    expect(readBucket(qc)).toEqual({ emoji: '👍', count: 2, byMe: false });

    await act(async () => {
      vi.advanceTimersByTime(REACTION_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 실패 → 버스트 시작 스냅샷(count 3 / byMe true)으로 정확 복원.
    expect(readBucket(qc)).toEqual({ emoji: '👍', count: 3, byMe: true });
    expect(pushNotification).toHaveBeenCalledTimes(1);
    // 의도는 제거됐다.
    expect(peekReactionIntent(MSG, '👍')).toBeNull();
  });
});
