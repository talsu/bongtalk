import { describe, it, expect, beforeEach, vi } from 'vitest';
import { snoozeUntil, SNOOZE_PRESET_OPTIONS } from './dndSnooze';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('snoozeUntil (S48 FR-MN-11)', () => {
  const now = new Date('2025-01-01T10:00:00Z');

  it('thirty_min → now + 30분', () => {
    expect(snoozeUntil('thirty_min', now).getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it('one_hour → now + 60분', () => {
    expect(snoozeUntil('one_hour', now).getTime()).toBe(now.getTime() + 60 * 60_000);
  });

  it('two_hours → now + 120분', () => {
    expect(snoozeUntil('two_hours', now).getTime()).toBe(now.getTime() + 120 * 60_000);
  });

  it('tomorrow → 다음 날 로컬 09:00(같은 날이 아니다)', () => {
    const r = snoozeUntil('tomorrow', now);
    expect(r.getDate()).toBe(new Date(now.getTime() + 24 * 3600_000).getDate());
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(0);
    expect(r.getTime()).toBeGreaterThan(now.getTime());
  });

  it('프리셋 옵션은 4개(30분/1시간/2시간/내일 오전)', () => {
    expect(SNOOZE_PRESET_OPTIONS.map((o) => o.value)).toEqual([
      'thirty_min',
      'one_hour',
      'two_hours',
      'tomorrow',
    ]);
  });
});
