import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatMuteRemaining } from './muteRemaining';

/**
 * S49 (D06 / FR-MN-17): 뮤트 남은 시간 포맷터. 단위 1개(일|시간|분) + 영구/곧해제
 * 경계를 결정적으로 검증한다(vi.setSystemTime 기준).
 */
describe('formatMuteRemaining (FR-MN-17)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  const NOW = Date.parse('2025-01-01T00:00:00Z');

  it('null → 무기한', () => {
    expect(formatMuteRemaining(null, NOW)).toBe('무기한');
  });

  it('파싱 불가 → 무기한(안전)', () => {
    expect(formatMuteRemaining('not-a-date', NOW)).toBe('무기한');
  });

  it('과거/경계(<= now) → 곧 해제됨', () => {
    expect(formatMuteRemaining('2024-12-31T23:59:59Z', NOW)).toBe('곧 해제됨');
    expect(formatMuteRemaining('2025-01-01T00:00:00Z', NOW)).toBe('곧 해제됨');
  });

  it('1분 미만 → 1분 미만 남음', () => {
    expect(formatMuteRemaining('2025-01-01T00:00:30Z', NOW)).toBe('1분 미만 남음');
  });

  it('분 단위', () => {
    expect(formatMuteRemaining('2025-01-01T00:15:00Z', NOW)).toBe('약 15분 남음');
    expect(formatMuteRemaining('2025-01-01T00:59:59Z', NOW)).toBe('약 59분 남음');
  });

  it('시간 단위', () => {
    expect(formatMuteRemaining('2025-01-01T01:00:00Z', NOW)).toBe('약 1시간 남음');
    expect(formatMuteRemaining('2025-01-01T08:30:00Z', NOW)).toBe('약 8시간 남음');
  });

  it('일 단위', () => {
    expect(formatMuteRemaining('2025-01-02T00:00:00Z', NOW)).toBe('약 1일 남음');
    expect(formatMuteRemaining('2025-01-04T12:00:00Z', NOW)).toBe('약 3일 남음');
  });
});
