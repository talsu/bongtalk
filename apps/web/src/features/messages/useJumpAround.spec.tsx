// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ListMessagesResponse } from '@qufox/shared-types';

/**
 * S37 fix-forward (BLOCKER-1): `?msg=` 점프 전용 one-shot around 로드 회귀.
 *
 * 핵심 보장:
 *   - jumpMessageId 가 있으면 listMessages(around=<id>) 가 실제로 발화한다
 *     (메인 list 캐시가 이미 있어도 — 이 쿼리는 jump-scoped 키라 별도 발화).
 *   - jumpMessageId 가 없으면 비활성(fetch 0).
 *   - 404(MESSAGE_NOT_FOUND) anchor 는 error 상태로 흐른다(토스트 판정 입력).
 */

const listMessages = vi.fn();
vi.mock('./api', () => ({
  listMessages: (...args: unknown[]) => listMessages(...args),
  // useMessages 가 같은 모듈에서 import 하는 나머지 함수 — 미사용이라 noop.
  deleteMessage: vi.fn(),
  getEditHistory: vi.fn(),
  pinMessage: vi.fn(),
  sendMessage: vi.fn(),
  unpinMessage: vi.fn(),
  updateMessage: vi.fn(),
}));

import { useJumpAround } from './useMessages';

const WS = 'ws-1';
const CH = 'ch-1';
const TARGET = '99999999-9999-4999-8999-999999999999';

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function aroundResponse(): ListMessagesResponse {
  return {
    items: [
      {
        id: TARGET,
        channelId: '22222222-2222-4222-8222-222222222222',
        authorId: '33333333-3333-4333-8333-333333333333',
        content: 'target body',
        contentRaw: 'target body',
        contentAst: null,
        contentPlain: 'target body',
        type: 'DEFAULT',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
        edited: false,
        deleted: false,
        createdAt: '2025-01-01T00:00:00.000Z',
        editedAt: null,
        reactions: [],
        parentMessageId: null,
        thread: null,
        attachments: [],
        pinnedAt: null,
        pinnedBy: null,
        version: 0,
        isBroadcast: false,
        parentExcerpt: null,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  listMessages.mockReset();
});

describe('useJumpAround (S37 BLOCKER-1)', () => {
  it('jumpMessageId 가 있으면 around=<id> 로 around-load 를 발화한다', async () => {
    listMessages.mockResolvedValueOnce(aroundResponse());
    const qc = makeClient();
    const { result } = renderHook(() => useJumpAround(WS, CH, TARGET), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listMessages).toHaveBeenCalledTimes(1);
    const [wsArg, chArg, queryArg] = listMessages.mock.calls[0];
    expect(wsArg).toBe(WS);
    expect(chArg).toBe(CH);
    expect((queryArg as { around?: string }).around).toBe(TARGET);
    // 결과에 대상 id 가 포함된다(존재 메시지 → 스크롤 seed 대상).
    expect(result.current.data?.items.some((m) => m.id === TARGET)).toBe(true);
  });

  it('jumpMessageId 가 없으면 비활성 — fetch 0', () => {
    const qc = makeClient();
    renderHook(() => useJumpAround(WS, CH, null), { wrapper: wrapper(qc) });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('404(MESSAGE_NOT_FOUND) anchor 는 error 상태로 흐른다(not-found 토스트 입력)', async () => {
    const err = Object.assign(new Error('not found'), {
      errorCode: 'MESSAGE_NOT_FOUND',
      status: 404,
    });
    listMessages.mockRejectedValueOnce(err);
    const qc = makeClient();
    const { result } = renderHook(() => useJumpAround(WS, CH, TARGET), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { errorCode?: string }).errorCode).toBe('MESSAGE_NOT_FOUND');
  });
});
