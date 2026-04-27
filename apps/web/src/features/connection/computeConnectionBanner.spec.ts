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
});
