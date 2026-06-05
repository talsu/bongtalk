// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { WS_EVENTS } from '@qufox/shared-types';
import { installRealtimeDispatcher } from '../../realtime/dispatcher';
import { useNotifications } from '../../../stores/notification-store';

/**
 * S80 (D15 / FR-SC-06): dispatcher 의 reminder:fire 핸들러 단위 테스트.
 *
 * /remind 발화 수신 시 우하단 토스트(8초)가 push 되고, 채널 링크가 있으면 "채널로 이동"
 * 액션이 붙는지, 리마인더 목록 캐시가 무효화되는지 검증한다. S53 의 user:reminder_fire
 * (저장 메시지)와는 별개 와이어다.
 */
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
  reminderId: '11111111-1111-1111-1111-111111111111',
  message: '회의 준비',
  channelId: '22222222-2222-2222-2222-222222222222',
};

describe('dispatcher reminder:fire (S80 / FR-SC-06)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    useNotifications.setState({ items: [] });
  });

  it('발화 수신 시 8초 토스트를 push 하고 리마인더 캐시를 무효화한다', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const navigate = vi.fn();
    const detach = installRealtimeDispatcher(socket, qc, {
      viewerId: () => null,
      activeChannelId: () => null,
      navigate,
    });

    socket.emit(WS_EVENTS.REMINDER_NEW_FIRE, validFire);

    const toasts = useNotifications.getState().items;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('리마인더');
    expect(toasts[0].body).toBe('회의 준비');
    expect(toasts[0].ttlMs).toBe(8000);
    // 채널 링크가 있으면 "채널로 이동" 액션이 붙는다.
    expect(toasts[0].action?.label).toBe('채널로 이동');
    toasts[0].action?.onClick();
    expect(navigate).toHaveBeenCalledWith('/c/22222222-2222-2222-2222-222222222222');

    const keys = invalidate.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['reminders']));
    detach();
  });

  it('channelId 가 null 이면 액션 없이 토스트만 띄운다', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc, {
      viewerId: () => null,
      activeChannelId: () => null,
      navigate: vi.fn(),
    });
    socket.emit(WS_EVENTS.REMINDER_NEW_FIRE, { ...validFire, channelId: null });
    const toasts = useNotifications.getState().items;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].action).toBeUndefined();
    detach();
  });

  it('형식 불량 페이로드는 무시한다(토스트 없음)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit(WS_EVENTS.REMINDER_NEW_FIRE, { reminderId: 'not-a-uuid' });
    expect(useNotifications.getState().items).toHaveLength(0);
    detach();
  });
});
