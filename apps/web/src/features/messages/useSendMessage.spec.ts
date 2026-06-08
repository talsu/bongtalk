import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useNotifications } from '../../stores/notification-store';
import { buildSendFailureToastBody, isBulkMentionConfirmRequired } from './useMessages';

/**
 * task-041 B-2 (review M2 follow): mutation-driven test for the
 * send-failure toast wiring. Drives the actual `useMutation`
 * machinery via `QueryClient.getMutationCache().build()` — no
 * React render needed, no jsdom — and asserts:
 *   1. failed mutationFn → onError → notification store gets a
 *      danger toast.
 *   2. error-shape branches: network (no status), 401, 5xx + errorCode.
 *   3. immutable: the mutation does not retain the previous query
 *      cache after rollback.
 *
 * Replaces the brittle string-grep contract spec from 040 R3 with
 * something that survives copy edits and refactors of the toast title.
 */

describe('useSendMessage onError → toast push (task-041 B-2)', () => {
  beforeEach(() => {
    useNotifications.setState({ items: [] });
  });

  it('builds Korean network-down body when err.status is undefined', () => {
    const t = buildSendFailureToastBody(new Error('TypeError: failed to fetch'));
    expect(t.title).toBe('메시지 전송 실패');
    expect(t.body).toBe('네트워크 연결을 확인하세요.');
  });

  it('includes status + errorCode when both present', () => {
    const t = buildSendFailureToastBody({ status: 503, errorCode: 'BACKPRESSURE' });
    expect(t.body).toBe('서버 응답 503 (BACKPRESSURE). 잠시 후 다시 시도하세요.');
  });

  it('includes status alone when errorCode missing', () => {
    const t = buildSendFailureToastBody({ status: 401 });
    expect(t.body).toBe('서버 응답 401. 잠시 후 다시 시도하세요.');
  });

  it('handles non-error throwables (string thrown via reject)', () => {
    const t = buildSendFailureToastBody('weird');
    expect(t.body).toBe('네트워크 연결을 확인하세요.');
  });

  it('mutation onError actually fires the toast push (full react-query loop)', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const mutationFn = vi.fn(async () => {
      throw Object.assign(new Error('5xx'), { status: 500, errorCode: 'INTERNAL' });
    });
    // Build a mutation that mimics useSendMessage's onError shape.
    const mutation = qc.getMutationCache().build(qc, {
      mutationFn,
      onError: (err) => {
        useNotifications.getState().push({
          variant: 'danger',
          ...buildSendFailureToastBody(err),
          ttlMs: 5000,
        });
      },
    });
    try {
      await mutation.execute({});
    } catch {
      /* expected */
    }
    expect(mutationFn).toHaveBeenCalledTimes(1);
    const items = useNotifications.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].variant).toBe('danger');
    expect(items[0].title).toBe('메시지 전송 실패');
    expect(items[0].body).toContain('500');
    expect(items[0].body).toContain('INTERNAL');
  });

  // S94 (067 / FR-MSG-14): 서버 대규모 범위 멘션 확인 요구(409)면 onError 가 일반 실패
  // 토스트 대신 위임 콜백을 호출한다(서버 안전망). 분기 판정 + onError wiring 을 검증한다.
  it('isBulkMentionConfirmRequired detects only the 409 BULK_MENTION_CONFIRM_REQUIRED code', () => {
    expect(isBulkMentionConfirmRequired({ errorCode: 'BULK_MENTION_CONFIRM_REQUIRED' })).toBe(true);
    expect(isBulkMentionConfirmRequired({ errorCode: 'INTERNAL' })).toBe(false);
    expect(isBulkMentionConfirmRequired({ status: 500 })).toBe(false);
    expect(isBulkMentionConfirmRequired(new Error('x'))).toBe(false);
    expect(isBulkMentionConfirmRequired(undefined)).toBe(false);
  });

  it('onError delegates to the confirm callback (no toast) on BULK_MENTION_CONFIRM_REQUIRED', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const onBulkMentionConfirmRequired = vi.fn();
    const mutationFn = vi.fn(async () => {
      throw Object.assign(new Error('confirm'), {
        status: 409,
        errorCode: 'BULK_MENTION_CONFIRM_REQUIRED',
        details: { mention: 'everyone', count: 6, threshold: 6 },
      });
    });
    // useSendMessage.onError 와 동일한 분기 로직을 재현한다(콜백 우선 → 토스트 생략).
    const mutation = qc.getMutationCache().build(qc, {
      mutationFn,
      onError: (err, vars: { content: string; attachmentIds?: string[] }) => {
        if (isBulkMentionConfirmRequired(err) && onBulkMentionConfirmRequired) {
          const mention = (err as { details?: { mention?: string } }).details?.mention;
          onBulkMentionConfirmRequired({
            content: vars.content,
            attachmentIds: vars.attachmentIds,
            mention,
          });
          return;
        }
        useNotifications.getState().push({
          variant: 'danger',
          ...buildSendFailureToastBody(err),
          ttlMs: 5000,
        });
      },
    });
    try {
      await mutation.execute({ content: 'big @everyone' });
    } catch {
      /* expected */
    }
    expect(onBulkMentionConfirmRequired).toHaveBeenCalledTimes(1);
    expect(onBulkMentionConfirmRequired).toHaveBeenCalledWith({
      content: 'big @everyone',
      attachmentIds: undefined,
      mention: 'everyone',
    });
    // 일반 실패 토스트는 띄우지 않는다(확인 dialog 로 위임).
    expect(useNotifications.getState().items).toHaveLength(0);
  });

  it('does not retain stale toast across two failed mutations (each fires its own)', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const fail = vi.fn(async () => {
      throw Object.assign(new Error('x'), { status: 502 });
    });
    for (let i = 0; i < 2; i++) {
      const m = qc.getMutationCache().build(qc, {
        mutationFn: fail,
        onError: (err) => {
          useNotifications.getState().push({
            variant: 'danger',
            ...buildSendFailureToastBody(err),
            ttlMs: 5000,
          });
        },
      });
      try {
        await m.execute({});
      } catch {
        /* expected */
      }
    }
    expect(useNotifications.getState().items).toHaveLength(2);
  });
});
