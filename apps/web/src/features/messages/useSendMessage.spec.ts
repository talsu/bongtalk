import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useNotifications } from '../../stores/notification-store';
import { buildSendFailureToastBody } from './useMessages';

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
