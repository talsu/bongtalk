import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatMessageTime,
  formatMessageTimeISO,
  formatDayDivider,
  formatClockPart,
  isSameLocalDay,
  localDayKey,
} from './formatMessageTime';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * "오늘/어제/N일 전" 은 로컬 자정 경계 기준이고, 시각 포맷은 getHours/
 * getMinutes(로컬) 를 씁니다. 테스트 실행 머신의 타임존에 의존하지 않도록
 * 로컬 시각 생성자(new Date(y, m, d, h, min)) 로 픽스처를 만들고, 그 .toISOString()
 * 을 포맷터에 넘깁니다. now 도 동일 방식으로 만들어 두 값의 달력 일 차이만
 * 검증 대상이 되게 합니다.
 */
function localIso(y: number, mZeroBased: number, d: number, h = 12, min = 0): string {
  return new Date(y, mZeroBased, d, h, min, 0, 0).toISOString();
}

describe('formatMessageTime — 오늘 (FR-MSG-12)', () => {
  it('clock24h=true 면 24시간제 HH:MM 으로 zero-pad', () => {
    const now = new Date(2025, 0, 1, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 1, 9, 5), now, { clock24h: true })).toBe('09:05');
    expect(formatMessageTime(localIso(2025, 0, 1, 23, 59), now, { clock24h: true })).toBe('23:59');
    expect(formatMessageTime(localIso(2025, 0, 1, 0, 0), now, { clock24h: true })).toBe('00:00');
  });

  it('clock24h=false 면 오전/오후 H:MM (시는 비-pad, 분은 pad)', () => {
    const now = new Date(2025, 0, 1, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 1, 9, 5), now, { clock24h: false })).toBe(
      '오전 9:05',
    );
    expect(formatMessageTime(localIso(2025, 0, 1, 0, 0), now, { clock24h: false })).toBe(
      '오전 12:00',
    );
    expect(formatMessageTime(localIso(2025, 0, 1, 12, 0), now, { clock24h: false })).toBe(
      '오후 12:00',
    );
    expect(formatMessageTime(localIso(2025, 0, 1, 13, 7), now, { clock24h: false })).toBe(
      '오후 1:07',
    );
  });

  it('clock24h 기본값은 true(24시간제)', () => {
    const now = new Date(2025, 0, 1, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 1, 13, 7), now)).toBe('13:07');
  });
});

describe('formatMessageTime — 어제 / N일 전 (FR-MSG-12, 자정 경계)', () => {
  it('어제는 "어제 HH:MM"', () => {
    const now = new Date(2025, 0, 2, 0, 1); // 오늘 00:01
    // 어제 23:59 — 시차는 2분이지만 달력 일이 다르므로 "어제".
    expect(formatMessageTime(localIso(2025, 0, 1, 23, 59), now, { clock24h: true })).toBe(
      '어제 23:59',
    );
  });

  it('3일 전은 "3일 전 HH:MM"', () => {
    const now = new Date(2025, 0, 5, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 2, 8, 30), now, { clock24h: true })).toBe(
      '3일 전 08:30',
    );
  });

  it('6일 전(경계 안)은 "6일 전 …"', () => {
    const now = new Date(2025, 0, 8, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 2, 10, 0), now, { clock24h: true })).toBe(
      '6일 전 10:00',
    );
  });
});

describe('formatMessageTime — 7일 이상 전 (FR-MSG-12)', () => {
  it('8일 전은 절대 날짜 "YYYY년 MM월 DD일"', () => {
    const now = new Date(2025, 0, 10, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 2, 10, 0), now, { clock24h: true })).toBe(
      '2025년 01월 02일',
    );
  });

  it('7일 전(경계 밖)도 절대 날짜', () => {
    const now = new Date(2025, 0, 9, 12, 0);
    expect(formatMessageTime(localIso(2025, 0, 2, 10, 0), now, { clock24h: true })).toBe(
      '2025년 01월 02일',
    );
  });
});

describe('formatClockPart', () => {
  it('24h / 12h 분기', () => {
    const d = new Date(2025, 0, 1, 15, 3);
    expect(formatClockPart(d, true)).toBe('15:03');
    expect(formatClockPart(d, false)).toBe('오후 3:03');
  });
});

describe('formatMessageTimeISO', () => {
  it('ISO 8601 전체 문자열을 그대로 반환', () => {
    expect(formatMessageTimeISO('2025-01-01T09:05:00.000Z')).toBe('2025-01-01T09:05:00.000Z');
  });
});

describe('formatDayDivider (FR-MSG-11)', () => {
  it('YYYY년 MM월 DD일 형식', () => {
    expect(formatDayDivider(localIso(2026, 0, 1, 9, 0))).toBe('2026년 01월 01일');
  });
});

describe('isSameLocalDay / localDayKey (FR-MSG-11)', () => {
  it('같은 달력 일은 true, 자정 경계 교차는 false', () => {
    const a = localIso(2025, 0, 1, 0, 1);
    const b = localIso(2025, 0, 1, 23, 59);
    const c = localIso(2025, 0, 2, 0, 1);
    expect(isSameLocalDay(a, b)).toBe(true);
    expect(isSameLocalDay(b, c)).toBe(false);
  });

  it('localDayKey 는 YYYY-MM-DD 안정 키', () => {
    expect(localDayKey(localIso(2025, 0, 2, 10, 0))).toBe('2025-01-02');
  });
});

describe('invalid/누락 iso 방어 (S06 review F1)', () => {
  // 이전 toLocaleTimeString 은 'Invalid Date' 로 degrade 했고, formatMessageTimeISO
  // 는 invalid 시 toISOString 이 RangeError 를 던져 전체 MessageList 렌더를 크래시
  // 시킬 수 있었다. 모든 진입점이 throw 없이 빈 문자열로 안전 폴백해야 한다.
  for (const bad of ['', 'not-a-date', 'undefined']) {
    it(`'${bad}' → throw 없이 빈 문자열 폴백`, () => {
      expect(() => formatMessageTime(bad, new Date())).not.toThrow();
      expect(formatMessageTime(bad, new Date())).toBe('');
      expect(() => formatMessageTimeISO(bad)).not.toThrow();
      expect(formatMessageTimeISO(bad)).toBe('');
      expect(formatDayDivider(bad)).toBe('');
      expect(localDayKey(bad)).toBe('');
      expect(isSameLocalDay(bad, localIso(2025, 0, 1, 0, 0))).toBe(false);
    });
  }
});
