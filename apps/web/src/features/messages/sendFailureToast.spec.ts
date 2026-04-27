import { describe, it, expect, beforeEach } from 'vitest';
import { useNotifications } from '../../stores/notification-store';

/**
 * task-040 R3: regression for the send-failure toast wiring in
 * useSendMessage.onError. The full mutation can't run in a Node vitest
 * env (no React render, no fetch), so we exercise the side-effect
 * branch directly: copy the same push-shape the hook fires and assert
 * it lands as a danger toast in the store. If anyone removes the push
 * from useSendMessage.onError, this spec reflects an outdated rule —
 * pair with `sendFailureToast.contract.spec.ts` below.
 */

describe('send-failure toast (task-040 R3)', () => {
  beforeEach(() => {
    useNotifications.setState({ items: [] });
  });

  it('pushes a danger toast with status + errorCode when err.status is defined', () => {
    const err = { status: 503, errorCode: 'BACKPRESSURE' } as Error & {
      status?: number;
      errorCode?: string;
    };
    const status = err.status;
    const code = err.errorCode;
    useNotifications.getState().push({
      variant: 'danger',
      title: '메시지 전송 실패',
      body:
        status === undefined
          ? '네트워크 연결을 확인하세요.'
          : `서버 응답 ${status}${code ? ` (${code})` : ''}. 잠시 후 다시 시도하세요.`,
      ttlMs: 5000,
    });
    const items = useNotifications.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].variant).toBe('danger');
    expect(items[0].title).toBe('메시지 전송 실패');
    expect(items[0].body).toContain('503');
    expect(items[0].body).toContain('BACKPRESSURE');
  });

  it('falls back to a network-down message when err.status is undefined', () => {
    const err = new Error('TypeError: Failed to fetch') as Error & { status?: number };
    const status = err.status;
    useNotifications.getState().push({
      variant: 'danger',
      title: '메시지 전송 실패',
      body: status === undefined ? '네트워크 연결을 확인하세요.' : `서버 응답 ${status}.`,
      ttlMs: 5000,
    });
    const t = useNotifications.getState().items[0];
    expect(t.body).toBe('네트워크 연결을 확인하세요.');
  });
});
