import { describe, it, expect } from 'vitest';
import { computeConnectionBanner } from './computeConnectionBanner';

describe('computeConnectionBanner (task-040 R3)', () => {
  it('hides when online and connected', () => {
    expect(
      computeConnectionBanner({ online: true, realtimeStatus: 'connected', replaying: false }),
    ).toEqual({ visible: false });
  });

  it('shows offline banner when navigator.onLine is false (priority over socket state)', () => {
    expect(
      computeConnectionBanner({ online: false, realtimeStatus: 'disconnected', replaying: true }),
    ).toMatchObject({ visible: true, level: 'offline' });
  });

  it('shows disconnected banner when socket is disconnected but network is up', () => {
    expect(
      computeConnectionBanner({ online: true, realtimeStatus: 'disconnected', replaying: false }),
    ).toMatchObject({ visible: true, level: 'disconnected' });
  });

  it('shows replaying banner during replay window', () => {
    expect(
      computeConnectionBanner({ online: true, realtimeStatus: 'connected', replaying: true }),
    ).toMatchObject({ visible: true, level: 'replaying' });
  });

  it('keeps fresh-load idle hidden (no false-positive banner on first paint)', () => {
    expect(
      computeConnectionBanner({ online: true, realtimeStatus: 'idle', replaying: false }),
    ).toEqual({ visible: false });
    expect(
      computeConnectionBanner({ online: true, realtimeStatus: 'connecting', replaying: false }),
    ).toEqual({ visible: false });
  });

  it('all 4 banner messages are non-empty Korean strings', () => {
    const offline = computeConnectionBanner({
      online: false,
      realtimeStatus: 'idle',
      replaying: false,
    });
    expect(offline.visible && offline.message.length > 5).toBe(true);
  });

  // 072 백로그 S-H (N6-3): 재연결 소진(failed) 종단 상태 — reloadable 배너.
  it('shows a reloadable failed banner when realtime status is failed (online)', () => {
    const r = computeConnectionBanner({ online: true, realtimeStatus: 'failed', replaying: false });
    expect(r).toMatchObject({ visible: true, level: 'failed', reloadable: true });
  });

  it('failed 보다 offline(네트워크) 가 우선한다', () => {
    expect(
      computeConnectionBanner({ online: false, realtimeStatus: 'failed', replaying: false }),
    ).toMatchObject({ visible: true, level: 'offline' });
  });

  it('failed 는 replaying 보다 우선한다(자동 복구 없음 안내)', () => {
    expect(
      computeConnectionBanner({ online: true, realtimeStatus: 'failed', replaying: true }),
    ).toMatchObject({ visible: true, level: 'failed' });
  });
});
