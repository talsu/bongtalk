import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';
import { applyTimeoutFailure } from './timeoutFlip';
import { confirmOptimistic, optimisticIdFor, type OptimisticMessage } from './sendState';

/**
 * S09 (FR-RT-05): 전송 타임아웃 배선 검증.
 *
 * `useSendMessage` 의 타이머/AbortController/onSettled clear 구조를 그대로
 * 재현한 mutation 을 `QueryClient.getMutationCache().build()` 로 구동합니다
 * (React 렌더 없이 — 기존 useSendMessage.spec.ts 와 동일 전략). 검증:
 *   1. 타임아웃 경과 + 201 미수신 → 낙관 행 'failed' flip + fetch abort.
 *   2. 타임아웃 전에 201 도착 → onSettled 가 타이머 clear → 늦게 발화해도
 *      추가 flip 없음(confirmed 행 유지).
 */

const KEY = qk.messages.list('ws-1', 'ch-1');
const TIMEOUT = 5000;

function pendingRow(id: string): OptimisticMessage {
  return {
    id,
    channelId: 'ch-1',
    authorId: 'u-1',
    content: 'hi',
    contentRaw: 'hi',
    contentAst: null,
    contentPlain: 'hi',
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
    threadLocked: false,
    embeds: [],
    sendState: 'pending',
  };
}

function seedCache(qc: QueryClient, rows: OptimisticMessage[]): void {
  qc.setQueryData<InfiniteData<ListMessagesResponse>>(KEY, {
    pages: [
      {
        items: rows as MessageDto[],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      } as ListMessagesResponse,
    ],
    pageParams: [undefined],
  });
}

function rowState(qc: QueryClient, id: string): string | undefined {
  const data = qc.getQueryData<InfiniteData<ListMessagesResponse>>(KEY);
  const row = data?.pages[0].items.find((m) => m.id === id) as OptimisticMessage | undefined;
  return row?.sendState;
}

/** useSendMessage 의 타이머/abort/clear 배선을 그대로 재현하는 헬퍼. */
function buildSendMutation(
  qc: QueryClient,
  pending: Map<string, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>,
  mutationFn: (args: { clientNonce: string; signal: AbortSignal }) => Promise<unknown>,
) {
  const clearPending = (id: string) => {
    const e = pending.get(id);
    if (e) {
      clearTimeout(e.timer);
      pending.delete(id);
    }
  };
  return qc.getMutationCache().build<unknown, unknown, { clientNonce: string }, unknown>(qc, {
    mutationFn: async ({ clientNonce }) => {
      const id = optimisticIdFor(clientNonce);
      clearPending(id);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        qc.setQueryData<InfiniteData<ListMessagesResponse>>(KEY, (old) =>
          applyTimeoutFailure(old, id),
        );
        controller.abort();
      }, TIMEOUT);
      pending.set(id, { timer, controller });
      return mutationFn({ clientNonce, signal: controller.signal });
    },
    onSuccess: (result, { clientNonce }) => {
      const id = optimisticIdFor(clientNonce);
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(KEY, (old) =>
        confirmOptimistic(old, id, (result as { message: MessageDto }).message),
      );
    },
    onSettled: (_r, _e, { clientNonce }) => clearPending(optimisticIdFor(clientNonce)),
  });
}

describe('useSendMessage timeout wiring (FR-RT-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('타임아웃 경과 + 201 미수신 → 낙관 행 failed flip + fetch abort', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const nonce = 'nonce-timeout';
    const id = optimisticIdFor(nonce);
    seedCache(qc, [pendingRow(id)]);

    const pending = new Map<
      string,
      { timer: ReturnType<typeof setTimeout>; controller: AbortController }
    >();
    let abortedSignal: AbortSignal | null = null;
    // 영원히 hang 하는 fetch — abort 신호가 떨어질 때만 reject.
    const mutation = buildSendMutation(qc, pending, ({ signal }) => {
      abortedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const exec = mutation.execute({ clientNonce: nonce }).catch(() => undefined);
    // 타임아웃 직전: 여전히 pending.
    expect(rowState(qc, id)).toBe('pending');
    // 타임아웃 경과.
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    expect(rowState(qc, id)).toBe('failed');
    expect(abortedSignal).not.toBeNull();
    expect(abortedSignal!.aborted).toBe(true);
    await exec;
  });

  it('정상 201 → onSettled 가 타이머 clear → 늦은 발화 없이 confirmed 유지', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const nonce = 'nonce-ok';
    const id = optimisticIdFor(nonce);
    seedCache(qc, [pendingRow(id)]);

    const pending = new Map<
      string,
      { timer: ReturnType<typeof setTimeout>; controller: AbortController }
    >();
    const confirmed: MessageDto = { ...pendingRow('real-1'), sendState: undefined } as MessageDto;
    const mutation = buildSendMutation(qc, pending, () =>
      Promise.resolve({ message: confirmed, replayed: false }),
    );

    await mutation.execute({ clientNonce: nonce });
    // confirmed 행으로 교체됨.
    const data = qc.getQueryData<InfiniteData<ListMessagesResponse>>(KEY);
    expect(data?.pages[0].items.some((m) => m.id === 'real-1')).toBe(true);
    expect(data?.pages[0].items.some((m) => m.id === id)).toBe(false);
    // 타이머가 clear 되었어야 함 → pending 맵 비어있음.
    expect(pending.size).toBe(0);
    // 타임아웃 시간이 지나도 추가 flip 없음(confirmed 행 유지, failed 없음).
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    const after = qc.getQueryData<InfiniteData<ListMessagesResponse>>(KEY);
    expect(after?.pages[0].items.some((m) => m.id === 'real-1')).toBe(true);
    expect(
      (after?.pages[0].items as OptimisticMessage[]).some((m) => m.sendState === 'failed'),
    ).toBe(false);
  });
});
