import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computePopupMaxHeight } from './popupMaxHeight';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('computePopupMaxHeight (모바일 visualViewport) — 가상키보드 보정', () => {
  it('uses the visual viewport height minus the composer/reserve when the keyboard is open', () => {
    // viewport 700, keyboard 300 → visual height ~400; reserve 120 for the
    // composer + safe area → popup gets 280.
    const h = computePopupMaxHeight({ viewportHeight: 400, reserve: 120, hardCap: 280 });
    expect(h).toBe(280);
  });

  it('never exceeds the desktop hard cap (280px)', () => {
    const h = computePopupMaxHeight({ viewportHeight: 1000, reserve: 120, hardCap: 280 });
    expect(h).toBe(280);
  });

  it('shrinks below the hard cap on a short visual viewport', () => {
    const h = computePopupMaxHeight({ viewportHeight: 320, reserve: 120, hardCap: 280 });
    expect(h).toBe(200);
  });

  it('clamps to a sensible minimum so at least one row shows', () => {
    const h = computePopupMaxHeight({ viewportHeight: 100, reserve: 120, hardCap: 280 });
    expect(h).toBe(96);
  });
});
