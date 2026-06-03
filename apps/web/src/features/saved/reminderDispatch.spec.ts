// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { WS_EVENTS } from '@qufox/shared-types';
import { installRealtimeDispatcher } from '../realtime/dispatcher';
import { useNotifications } from '../../stores/notification-store';

// S53 (D10 / FR-PS-09): dispatcher 의 user:reminder_fire 핸들러 단위 테스트.
// 발화 수신 시 토스트(액션: "10분 후 다시")가 push 되는지, 저장 캐시가 무효화되는지
// 검증한다(브라우저 Notification 은 권한 default 라 생성 안 됨 — 토스트 폴백만 확인).

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

const validFire = {
  savedMessageId: '11111111-1111-1111-1111-111111111111',
  messageId: '22222222-2222-2222-2222-222222222222',
  channelId: '33333333-3333-3333-3333-333333333333',
  channelName: 'general',
  messagePreview: '나중에 다시 볼 메시지',
  originalSavedAt: '2025-01-01T00:00:00.000Z',
};

describe('dispatcher user:reminder_fire', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    useNotifications.setState({ items: [] });
  });

  it('발화 수신 시 토스트를 push 하고 저장 캐시를 무효화한다', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const detach = installRealtimeDispatcher(socket, qc);

    socket.emit(WS_EVENTS.REMINDER_FIRE, validFire);

    const toasts = useNotifications.getState().items;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('저장한 메시지 리마인더');
    expect(toasts[0].body).toContain('general');
    expect(toasts[0].body).toContain('나중에 다시 볼 메시지');
    expect(toasts[0].action?.label).toBe('10분 후 다시');

    // 저장 목록 + 카운트 무효화.
    const keys = invalidate.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['saved', 'list']));
    expect(keys).toContain(JSON.stringify(['saved', 'count']));
    detach();
  });

  it('형식 불량 페이로드는 무시한다(토스트 없음)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit(WS_EVENTS.REMINDER_FIRE, { savedMessageId: 'not-a-uuid' });
    expect(useNotifications.getState().items).toHaveLength(0);
    detach();
  });

  it('user:saved_updated 는 저장 캐시를 무효화한다', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit(WS_EVENTS.SAVED_UPDATED, {
      savedMessageId: validFire.savedMessageId,
      status: 'IN_PROGRESS',
      reminderAt: null,
    });
    const keys = invalidate.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['saved', 'list']));
    expect(keys).toContain(JSON.stringify(['saved', 'count']));
    detach();
  });
});
