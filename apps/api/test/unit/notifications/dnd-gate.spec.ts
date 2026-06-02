import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isDndSuppressed } from '../../../src/notifications/dnd-gate';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('isDndSuppressed (S28 FR-P05/P06)', () => {
  const wed = new Date('2025-01-01T12:30:00Z'); // Wed 12:30 UTC

  it('수동 DND(presencePreference=dnd) → 항상 suppressed', () => {
    expect(isDndSuppressed({ presencePreference: 'dnd', dndSchedule: null }, wed)).toBe(true);
  });

  it('auto + 스케줄 없음 → not suppressed', () => {
    expect(isDndSuppressed({ presencePreference: 'auto', dndSchedule: null }, wed)).toBe(false);
  });

  it('invisible + 스케줄 없음 → not suppressed (invisible 은 알림 차단 아님)', () => {
    expect(isDndSuppressed({ presencePreference: 'invisible', dndSchedule: null }, wed)).toBe(
      false,
    );
  });

  it('auto + 스케줄 구간 활성 → suppressed', () => {
    const sched = { days: [{ day: 3, startMin: 12 * 60, endMin: 13 * 60 }] }; // Wed 12:00~13:00
    expect(isDndSuppressed({ presencePreference: 'auto', dndSchedule: sched }, wed)).toBe(true);
  });

  it('auto + 스케줄 구간 비활성 → not suppressed', () => {
    const sched = { days: [{ day: 3, startMin: 14 * 60, endMin: 15 * 60 }] }; // Wed 14:00~15:00
    expect(isDndSuppressed({ presencePreference: 'auto', dndSchedule: sched }, wed)).toBe(false);
  });

  it('자정 걸침(start>end) — 저녁 부분(같은 요일 min≥start) + 다음날 새벽 carry(전날 entry)', () => {
    // Wed(day=3) 23:00→07:00 entry.
    const sched = { days: [{ day: 3, startMin: 23 * 60, endMin: 7 * 60 }] };
    // Wed 23:30 → 저녁 부분 활성.
    expect(
      isDndSuppressed(
        { presencePreference: 'auto', dndSchedule: sched },
        new Date('2025-01-01T23:30:00Z'),
      ),
    ).toBe(true);
    // Thu(2025-01-02, day=4) 03:00 → Wed entry 의 다음날 새벽 carry 활성(B1 BLOCKER).
    expect(
      isDndSuppressed(
        { presencePreference: 'auto', dndSchedule: sched },
        new Date('2025-01-02T03:00:00Z'),
      ),
    ).toBe(true);
    // Wed 03:00 → 전날(Tue) entry 가 없으므로 carry 없음 → 비활성(B1 BLOCKER 핵심:
    // 같은 요일의 새벽이 자동으로 켜지지 않는다 — 전날 overnight entry 가 있어야 carry).
    expect(
      isDndSuppressed(
        { presencePreference: 'auto', dndSchedule: sched },
        new Date('2025-01-01T03:00:00Z'),
      ),
    ).toBe(false);
    // Wed 12:00 → 어느 구간도 아님 → 비활성.
    expect(
      isDndSuppressed(
        { presencePreference: 'auto', dndSchedule: sched },
        new Date('2025-01-01T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('자정 걸침 carry — Tue+Wed entry 가 있으면 Wed 03:00 은 Tue entry 의 carry 로 활성', () => {
    // Tue(day=2) 와 Wed(day=3) 둘 다 23:00→07:00. Wed 03:00 은 Tue entry 의 carry.
    const sched = {
      days: [
        { day: 2, startMin: 23 * 60, endMin: 7 * 60 },
        { day: 3, startMin: 23 * 60, endMin: 7 * 60 },
      ],
    };
    expect(
      isDndSuppressed(
        { presencePreference: 'auto', dndSchedule: sched },
        new Date('2025-01-01T03:00:00Z'), // Wed 03:00 — Tue carry
      ),
    ).toBe(true);
  });

  // ── S48 (FR-MN-11): DND Snooze(dndUntil) 게이트 ─────────────────────────────
  describe('dndUntil snooze (S48 FR-MN-11)', () => {
    it('dndUntil 이 미래(at < dndUntil) → suppressed (auto 라도)', () => {
      const future = new Date('2025-01-01T13:00:00Z');
      expect(
        isDndSuppressed({ presencePreference: 'auto', dndSchedule: null, dndUntil: future }, wed),
      ).toBe(true);
    });

    it('dndUntil 이 과거(at >= dndUntil) → not suppressed (query-time 만료)', () => {
      const past = new Date('2025-01-01T12:00:00Z'); // wed=12:30 > past → 만료
      expect(
        isDndSuppressed({ presencePreference: 'auto', dndSchedule: null, dndUntil: past }, wed),
      ).toBe(false);
    });

    it('dndUntil === at (경계) → not suppressed (만료 시각 도달 = 해제)', () => {
      expect(
        isDndSuppressed({ presencePreference: 'auto', dndSchedule: null, dndUntil: wed }, wed),
      ).toBe(false);
    });

    it('dndUntil null/미지정 → 기존 동작(스케줄/수동만)', () => {
      expect(
        isDndSuppressed({ presencePreference: 'auto', dndSchedule: null, dndUntil: null }, wed),
      ).toBe(false);
      expect(isDndSuppressed({ presencePreference: 'auto', dndSchedule: null }, wed)).toBe(false);
    });

    it('수동 DND 가 dndUntil 보다 먼저 평가 — dndUntil 과거여도 dnd 면 suppressed', () => {
      const past = new Date('2025-01-01T12:00:00Z');
      expect(
        isDndSuppressed({ presencePreference: 'dnd', dndSchedule: null, dndUntil: past }, wed),
      ).toBe(true);
    });
  });
});
