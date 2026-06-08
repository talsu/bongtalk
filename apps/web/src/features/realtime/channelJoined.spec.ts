import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { installChannelSync } from './useChannelSync';
import { useReadState } from './readStateStore';

/**
 * S97 (FR-RT-22): channel:joined 의 lastReadMessageId 소비 — around-reload seam
 * 공급원이 클라에 도착하는 단일 진입점(useChannelSync 의 onChannelJoined)을
 * 검증한다. 서버 realtime.gateway 가 connect 직후 배치로 채워 보내고, 이 핸들러가
 * safeParse(ChannelJoinedPayloadSchema) 신뢰경계 가드를 통과한 payload 의
 * lastReadMessageId 를 readStateStore 에 기록한다(dispatcher 에 별도 리스너 없음 —
 * 중복 리스너 금지, 이 핸들러가 유일 소비처).
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

describe('channel:joined → readStateStore.setLastRead (FR-RT-22)', () => {
  let socket: ReturnType<typeof makeFakeSocket>;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
    useReadState.setState({ lastReadByChannel: {} });
    socket = makeFakeSocket();
    detach = installChannelSync(socket, new QueryClient());
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it('lastReadMessageId 동봉 시 readStateStore 에 기록', () => {
    socket.emit('channel:joined', { channelId: 'ch-1', seq: 7, lastReadMessageId: 'm-42' });
    expect(useReadState.getState().getLastRead('ch-1')).toBe('m-42');
  });

  it('lastReadMessageId=null 이면 기존 값을 제거(서버 권위 — 아직 읽은 적 없음)', () => {
    useReadState.getState().setLastRead('ch-1', 'm-9');
    socket.emit('channel:joined', { channelId: 'ch-1', seq: 7, lastReadMessageId: null });
    expect(useReadState.getState().getLastRead('ch-1')).toBeNull();
  });

  it('lastReadMessageId 누락(구 서버 baseline-only) 이면 store 미변경', () => {
    useReadState.getState().setLastRead('ch-1', 'm-9');
    socket.emit('channel:joined', { channelId: 'ch-1', seq: 7 });
    expect(useReadState.getState().getLastRead('ch-1')).toBe('m-9');
  });

  it('safeParse 가드: 형태가 어긋난 payload(채널 누락)는 store 를 건드리지 않는다', () => {
    useReadState.getState().setLastRead('ch-1', 'm-9');
    socket.emit('channel:joined', { seq: 7, lastReadMessageId: 'm-42' });
    socket.emit('channel:joined', { channelId: 'ch-1', lastReadMessageId: 'm-42' }); // seq 누락
    socket.emit('channel:joined', null);
    socket.emit('channel:joined', 'not-an-object');
    expect(useReadState.getState().getLastRead('ch-1')).toBe('m-9');
  });

  it('여러 채널의 baseline 스냅샷을 각각 독립 기록(connect 직후 채널당 1 emit)', () => {
    socket.emit('channel:joined', { channelId: 'ch-1', seq: 1, lastReadMessageId: 'm-1' });
    socket.emit('channel:joined', { channelId: 'ch-2', seq: 2, lastReadMessageId: 'm-2' });
    socket.emit('channel:joined', { channelId: 'ch-3', seq: 3, lastReadMessageId: null });
    expect(useReadState.getState().getLastRead('ch-1')).toBe('m-1');
    expect(useReadState.getState().getLastRead('ch-2')).toBe('m-2');
    expect(useReadState.getState().getLastRead('ch-3')).toBeNull();
  });
});
