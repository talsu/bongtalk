// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';
import type { OptimisticMessage } from './sendState';

/**
 * S94 fix-forward (067 / FR-MSG-14 · MED-1): 서버 대규모 범위 멘션 확인 요구(409)에 대한
 * 낙관행 처리 회귀 검증 — 실제 useSendMessage 훅을 renderHook 으로 구동해 query cache 를
 * 실제로 조작한다.
 *
 * 종전 버그: 409 onError 가 원래 send 의 낙관행을 markOptimisticFailed 로 표시한 뒤,
 * 재전송이 **새 clientNonce** 로 새 낙관행을 만들어 → 원래 실패행이 영구 잔류(딜리버된
 * 메시지 옆에 "다시 시도" 버블 stuck).
 *
 * 수정: 409 위임 시 원래 낙관행을 failed 로 표시하지 않고(pending 유지), 컴포저가 위임받은
 * **원래 clientNonce** 로 재전송하면 같은 낙관행이 markOptimisticPending 으로 되살아나
 * 그대로 confirmed 로 전환된다(중복 행/잔류 실패행 없음).
 *
 * 검증: 409 → confirm(같은 nonce 재전송) → success 후
 *   1. failed 상태 행이 하나도 없다.
 *   2. 낙관행이 정확히 한 번만 존재했고 confirmed 행으로 교체됐다(중복 없음).
 */

const WS = 'ws-1';
const CH = 'ch-1';
const KEY = qk.messages.list(WS, CH);

// api.sendMessage 를 mock — 첫 호출은 409, 재전송(bulkMentionConfirmed)은 성공.
const sendMessageMock = vi.fn();
vi.mock('./api', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

// useAuth — 안정된 viewer id.
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'viewer-1' } }),
}));

function seedEmptyPage(qc: QueryClient): void {
  qc.setQueryData<InfiniteData<ListMessagesResponse>>(KEY, {
    pages: [
      {
        items: [] as MessageDto[],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      } as ListMessagesResponse,
    ],
    pageParams: [undefined],
  });
}

function rows(qc: QueryClient): OptimisticMessage[] {
  const data = qc.getQueryData<InfiniteData<ListMessagesResponse>>(KEY);
  return (data?.pages.flatMap((p) => p.items) ?? []) as OptimisticMessage[];
}

describe('useSendMessage — bulk-mention 409 confirm flow (MED-1)', () => {
  beforeEach(() => {
    vi.setSystemTime('2025-01-01T00:00:00Z');
    sendMessageMock.mockReset();
  });
  afterEach(() => cleanup());

  it('409 → 같은 nonce 재전송 → success 후 잔류 failed 행이 없고 confirmed 1건만 남는다', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    seedEmptyPage(qc);

    // 컴포저가 위임받을 confirm 정보(원래 clientNonce 포함)를 캡처한다.
    let confirmInfo: {
      content: string;
      attachmentIds?: string[];
      mention?: string;
      clientNonce: string;
    } | null = null;

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { useSendMessage } = await import('./useMessages');
    const { result } = renderHook(
      () =>
        useSendMessage(WS, CH, (info) => {
          confirmInfo = info;
        }),
      { wrapper },
    );

    // 1) 첫 전송: 서버가 409 BULK_MENTION_CONFIRM_REQUIRED 를 던진다.
    sendMessageMock.mockRejectedValueOnce(
      Object.assign(new Error('confirm'), {
        status: 409,
        errorCode: 'BULK_MENTION_CONFIRM_REQUIRED',
        details: { mention: 'channel', count: 60, threshold: 50 },
      }),
    );

    await act(async () => {
      result.current.send('heads up @channel');
      // mutation 의 onError 까지 settle 되도록 microtask flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    // 위임 콜백이 원래 clientNonce 와 함께 호출됐다.
    expect(confirmInfo).not.toBeNull();
    expect(confirmInfo!.mention).toBe('channel');
    expect(typeof confirmInfo!.clientNonce).toBe('string');
    // 낙관행은 1건(pending) — 409 에서 failed 로 표시하지 않는다(MED-1).
    const afterReject = rows(qc);
    expect(afterReject).toHaveLength(1);
    expect(afterReject[0].sendState).toBe('pending');

    // 2) 확인 후 재전송: 같은 nonce + bulkMentionConfirmed=true → 성공.
    const confirmed: MessageDto = {
      ...afterReject[0],
      id: 'real-1',
      sendState: undefined,
    } as MessageDto;
    sendMessageMock.mockResolvedValueOnce({ message: confirmed, replayed: false });

    await act(async () => {
      result.current.send(
        confirmInfo!.content,
        confirmInfo!.attachmentIds,
        true,
        confirmInfo!.clientNonce,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // 3) 최종 캐시: confirmed 행 1건만, failed 행 0건, 낙관행(tmp-) 0건.
    const final = rows(qc);
    expect(final.some((m) => m.sendState === 'failed')).toBe(false);
    expect(final.filter((m) => m.id.startsWith('tmp-'))).toHaveLength(0);
    expect(final.filter((m) => m.id === 'real-1')).toHaveLength(1);
    expect(final).toHaveLength(1);

    // 재전송은 같은 nonce(=Idempotency-Key)로 나갔다 — 두 호출의 nonce 인자(index 3) 동일.
    // sendMessage(wsId, channelId, input, clientNonce, signal) — nonce 는 4번째 인자.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const firstNonce = sendMessageMock.mock.calls[0][3];
    const secondNonce = sendMessageMock.mock.calls[1][3];
    expect(secondNonce).toBe(firstNonce);
    // 재전송 본문(index 2)에 bulkMentionConfirmed=true 가 실렸다.
    expect(sendMessageMock.mock.calls[1][2]).toMatchObject({ bulkMentionConfirmed: true });
  });
});
