import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DndScheduleService } from '../../../src/me/dnd-schedule.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('DndScheduleService.validate (task-046 K1)', () => {
  it('null → null (disabled)', () => {
    expect(DndScheduleService.validate(null)).toBeNull();
    expect(DndScheduleService.validate(undefined)).toBeNull();
  });

  it('object 가 아니면 throw', () => {
    expect(() => DndScheduleService.validate('hi' as unknown)).toThrow(/object or null/);
    expect(() => DndScheduleService.validate(42 as unknown)).toThrow(/object or null/);
  });

  /**
   * task-047 iter0 (MED-046-4): validate() 가 raw Error 가 아닌
   * DomainError(VALIDATION_FAILED) 을 throw. 도메인 에러 계층 컨벤션
   * 일관성 검증.
   */
  it('throw 되는 에러는 DomainError(VALIDATION_FAILED) 인스턴스', () => {
    try {
      DndScheduleService.validate('not-an-object' as unknown);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('day 범위 위반도 DomainError 로 throw', () => {
    try {
      DndScheduleService.validate({ days: [{ day: 9, startMin: 0, endMin: 60 }] });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('days 배열 누락 시 throw', () => {
    expect(() => DndScheduleService.validate({})).toThrow(/days must be an array/);
  });

  it('day 가 0..6 범위 밖이면 throw', () => {
    expect(() =>
      DndScheduleService.validate({ days: [{ day: 7, startMin: 0, endMin: 60 }] }),
    ).toThrow(/day must be 0..6/);
    expect(() =>
      DndScheduleService.validate({ days: [{ day: -1, startMin: 0, endMin: 60 }] }),
    ).toThrow(/day must be 0..6/);
  });

  it('startMin / endMin 0..1439 검증', () => {
    expect(() =>
      DndScheduleService.validate({ days: [{ day: 0, startMin: -1, endMin: 60 }] }),
    ).toThrow(/startMin must be 0..1439/);
    expect(() =>
      DndScheduleService.validate({ days: [{ day: 0, startMin: 0, endMin: 1440 }] }),
    ).toThrow(/endMin must be 0..1439/);
  });

  it('start === end 인 zero-length window 차단', () => {
    expect(() =>
      DndScheduleService.validate({ days: [{ day: 0, startMin: 0, endMin: 0 }] }),
    ).toThrow(/zero-length/);
  });

  it('정상 entry → DndSchedule 반환', () => {
    const schedule = DndScheduleService.validate({
      days: [
        { day: 1, startMin: 23 * 60, endMin: 7 * 60 }, // overnight
        { day: 5, startMin: 12 * 60, endMin: 13 * 60 }, // 점심
      ],
    });
    expect(schedule?.days).toEqual([
      { day: 1, startMin: 1380, endMin: 420 },
      { day: 5, startMin: 720, endMin: 780 },
    ]);
  });

  it('cap (14 entries) 초과 차단', () => {
    const days = Array.from({ length: 15 }, (_, i) => ({
      day: i % 7,
      startMin: i,
      endMin: i + 1,
    }));
    expect(() => DndScheduleService.validate({ days })).toThrow(/too many entries/);
  });
});

describe('DndScheduleService.isActive (task-046 K1)', () => {
  it('null schedule → false', () => {
    expect(DndScheduleService.isActive(new Date('2025-01-01T00:00:00Z'), null)).toBe(false);
    expect(DndScheduleService.isActive(new Date('2025-01-01T00:00:00Z'), { days: [] })).toBe(false);
  });

  it('same-day window: 12:00 ~ 13:00 점심 휴식', () => {
    const sched = { days: [{ day: 3, startMin: 720, endMin: 780 }] }; // Wed
    // 2025-01-01 = Wed
    expect(DndScheduleService.isActive(new Date('2025-01-01T11:59:00Z'), sched)).toBe(false);
    expect(DndScheduleService.isActive(new Date('2025-01-01T12:00:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T12:30:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T13:00:00Z'), sched)).toBe(false); // exclusive end
  });

  it('overnight window: Wed 23:00 → 07:00 — 저녁 부분 + 다음날(Thu) 새벽 carry (B1 BLOCKER)', () => {
    const sched = { days: [{ day: 3, startMin: 23 * 60, endMin: 7 * 60 }] }; // Wed
    // 저녁 부분(같은 요일 min≥start).
    expect(DndScheduleService.isActive(new Date('2025-01-01T22:59:00Z'), sched)).toBe(false);
    expect(DndScheduleService.isActive(new Date('2025-01-01T23:00:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T23:59:00Z'), sched)).toBe(true);
    // B1 BLOCKER fix: 같은 요일(Wed) 새벽은 carry 가 아니다 — 전날(Tue) overnight
    // entry 가 있어야 carry 된다. Wed entry 단독이면 Wed 03:00 은 비활성.
    expect(DndScheduleService.isActive(new Date('2025-01-01T03:00:00Z'), sched)).toBe(false);
    // 다음날(Thu = 2025-01-02) 03:00 은 Wed entry 의 새벽 carry → 활성.
    expect(DndScheduleService.isActive(new Date('2025-01-02T03:00:00Z'), sched)).toBe(true);
    // Thu 07:00 은 carry 의 exclusive end → 비활성.
    expect(DndScheduleService.isActive(new Date('2025-01-02T07:00:00Z'), sched)).toBe(false);
  });

  it('다른 요일이면 active 아님', () => {
    const sched = { days: [{ day: 1, startMin: 0, endMin: 1439 }] }; // Mon
    // Wed (2025-01-01)
    expect(DndScheduleService.isActive(new Date('2025-01-01T12:00:00Z'), sched)).toBe(false);
  });

  it('동일 day 안에 다중 entry → 어느 하나라도 활성이면 true', () => {
    const sched = {
      days: [
        { day: 3, startMin: 0, endMin: 60 }, // 0:00 ~ 1:00
        { day: 3, startMin: 12 * 60, endMin: 13 * 60 }, // 12:00 ~ 13:00
      ],
    };
    expect(DndScheduleService.isActive(new Date('2025-01-01T00:30:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T06:00:00Z'), sched)).toBe(false);
    expect(DndScheduleService.isActive(new Date('2025-01-01T12:30:00Z'), sched)).toBe(true);
  });
});

// ── S48 (FR-MN-12): timezone 변환 ──────────────────────────────────────────────
describe('DndScheduleService.isActive timezone (S48 FR-MN-12)', () => {
  it('timezone 미지정/null → UTC 로 평가(기존 동작 동일)', () => {
    const sched = { days: [{ day: 3, startMin: 12 * 60, endMin: 13 * 60 }] }; // Wed 12:00~13:00 UTC
    const at = new Date('2025-01-01T12:30:00Z'); // Wed 12:30 UTC
    expect(DndScheduleService.isActive(at, sched)).toBe(true);
    expect(DndScheduleService.isActive(at, sched, null)).toBe(true);
  });

  it('Asia/Seoul(UTC+9): 22:00 local = 13:00 UTC, schedule 은 local 22:00~23:00', () => {
    // 2025-01-01T13:00:00Z = 2025-01-01 22:00 KST (여전히 Wed=3).
    const sched = { days: [{ day: 3, startMin: 22 * 60, endMin: 23 * 60 }] };
    const at = new Date('2025-01-01T13:00:00Z');
    expect(DndScheduleService.isActive(at, sched, 'Asia/Seoul')).toBe(true);
    // UTC 로 평가하면 13:00 UTC 라 22:00~23:00 구간 밖 → false (tz 미적용 시 회귀 검출).
    expect(DndScheduleService.isActive(at, sched, null)).toBe(false);
  });

  it('Asia/Seoul: 요일 경계 넘김 — 2025-01-01T16:00Z = 2025-01-02 01:00 KST(Thu=4)', () => {
    // UTC 로는 Wed 16:00 이지만 KST 로는 Thu 01:00. Thu 00:00~02:00 schedule 매칭.
    const sched = { days: [{ day: 4, startMin: 0, endMin: 2 * 60 }] }; // Thu 00:00~02:00
    const at = new Date('2025-01-01T16:00:00Z');
    expect(DndScheduleService.isActive(at, sched, 'Asia/Seoul')).toBe(true);
    // Wed schedule 로는 매칭 안 됨(요일 시프트 검증).
    const wedSched = { days: [{ day: 3, startMin: 0, endMin: 2 * 60 }] };
    expect(DndScheduleService.isActive(at, wedSched, 'Asia/Seoul')).toBe(false);
  });

  it('America/New_York DST 경계 — 2025-03-09 EST→EDT 전환(02:00 local skip)', () => {
    // 2025-03-09 07:00 UTC = 02:00 EST 직전(spring-forward 시점). DST 적용 후
    // 2025-03-09 07:00 UTC 는 EDT(UTC-4)로 03:00 local. schedule 03:00~04:00(Sun=0)
    // 가 매칭되어야 한다(Intl 이 올바른 offset 을 적용하는지).
    const sched = { days: [{ day: 0, startMin: 3 * 60, endMin: 4 * 60 }] }; // Sun 03:00~04:00
    const at = new Date('2025-03-09T07:00:00Z'); // = 03:00 EDT
    expect(DndScheduleService.isActive(at, sched, 'America/New_York')).toBe(true);
    // 같은 UTC 시각을 EST(UTC-5, 02:00)로 잘못 보면 매칭 안 됨 — DST 미처리 회귀 검출.
    const estSched = { days: [{ day: 0, startMin: 2 * 60, endMin: 3 * 60 }] }; // Sun 02:00~03:00
    expect(DndScheduleService.isActive(at, estSched, 'America/New_York')).toBe(false);
  });

  it('잘못된 timezone 문자열 → UTC fallback(throw 하지 않음)', () => {
    const sched = { days: [{ day: 3, startMin: 12 * 60, endMin: 13 * 60 }] };
    const at = new Date('2025-01-01T12:30:00Z');
    expect(DndScheduleService.isActive(at, sched, 'Not/AReal_Zone')).toBe(true);
  });
});
