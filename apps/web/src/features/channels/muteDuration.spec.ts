import { beforeEach, describe, expect, it, vi } from 'vitest';
import { muteUntilIso } from './useMutes';

describe('muteUntilIso (FR-CH-17)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  const now = () => Date.now();

  it('무기한(forever) → null', () => {
    expect(muteUntilIso('forever', now())).toBeNull();
  });

  it('15분 → now + 15min ISO', () => {
    expect(muteUntilIso('15m', now())).toBe('2025-01-01T00:15:00.000Z');
  });

  it('1시간 → now + 1h ISO', () => {
    expect(muteUntilIso('1h', now())).toBe('2025-01-01T01:00:00.000Z');
  });

  it('3시간 → now + 3h ISO', () => {
    expect(muteUntilIso('3h', now())).toBe('2025-01-01T03:00:00.000Z');
  });

  it('8시간 → now + 8h ISO', () => {
    expect(muteUntilIso('8h', now())).toBe('2025-01-01T08:00:00.000Z');
  });

  it('24시간 → now + 24h ISO', () => {
    expect(muteUntilIso('24h', now())).toBe('2025-01-02T00:00:00.000Z');
  });
});
