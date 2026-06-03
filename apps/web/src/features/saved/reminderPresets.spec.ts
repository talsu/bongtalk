import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeReminderAt, REMINDER_PRESETS } from './reminderPresets';

// S53 (D10 / FR-PS-09): 프리셋 시각 계산 단위 테스트. 모든 테스트 시작 시 시스템
// 시계를 고정한다(harness 규칙). tz 는 명시해 결정론적으로 검증한다.
describe('reminderPresets.computeReminderAt', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('in30m / in1h 은 tz 무관 now+delta UTC ISO', () => {
    const now = new Date('2025-01-01T12:00:00Z');
    expect(computeReminderAt('in30m', now, 'Asia/Seoul')).toBe('2025-01-01T12:30:00.000Z');
    expect(computeReminderAt('in1h', now, 'America/New_York')).toBe('2025-01-01T13:00:00.000Z');
  });

  it('내일 오전 9시 — Asia/Seoul(UTC+9) 기준 다음날 09:00 KST = 00:00Z', () => {
    // 2025-01-01 12:00Z = 2025-01-01 21:00 KST → 내일 = 1/2 09:00 KST = 1/2 00:00Z.
    const now = new Date('2025-01-01T12:00:00Z');
    expect(computeReminderAt('tomorrow9am', now, 'Asia/Seoul')).toBe('2025-01-02T00:00:00.000Z');
  });

  it('내일 오전 9시 — UTC 기준', () => {
    const now = new Date('2025-01-01T12:00:00Z');
    expect(computeReminderAt('tomorrow9am', now, 'UTC')).toBe('2025-01-02T09:00:00.000Z');
  });

  it('다음 주 월요일 오전 9시 — 2025-01-01(수)에서 다가오는 월요일 1/6 09:00 (UTC)', () => {
    // 2025-01-01 은 수요일. 다가오는 월요일은 2025-01-06.
    const now = new Date('2025-01-01T12:00:00Z');
    expect(computeReminderAt('nextMonday9am', now, 'UTC')).toBe('2025-01-06T09:00:00.000Z');
  });

  it('다음 주 월요일 — 오늘이 월요일이면 +7일(다음 주)', () => {
    // 2025-01-06 은 월요일. "다음 주 월요일" = 2025-01-13.
    const now = new Date('2025-01-06T12:00:00Z');
    expect(computeReminderAt('nextMonday9am', now, 'UTC')).toBe('2025-01-13T09:00:00.000Z');
  });

  it('custom 키는 null(호출자가 datetime-local 직접 변환)', () => {
    expect(computeReminderAt('custom', new Date(), 'UTC')).toBeNull();
  });

  it('프리셋 메뉴는 4개(직접 입력 제외)', () => {
    expect(REMINDER_PRESETS.map((p) => p.key)).toEqual([
      'in30m',
      'in1h',
      'tomorrow9am',
      'nextMonday9am',
    ]);
  });
});
