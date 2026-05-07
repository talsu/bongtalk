import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DndScheduleService } from '../../../src/me/dnd-schedule.service';

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

  it('overnight window: 23:00 → 07:00 매일밤', () => {
    const sched = { days: [{ day: 3, startMin: 23 * 60, endMin: 7 * 60 }] }; // Wed
    expect(DndScheduleService.isActive(new Date('2025-01-01T22:59:00Z'), sched)).toBe(false);
    expect(DndScheduleService.isActive(new Date('2025-01-01T23:00:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T23:59:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T03:00:00Z'), sched)).toBe(true);
    expect(DndScheduleService.isActive(new Date('2025-01-01T07:00:00Z'), sched)).toBe(false);
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
