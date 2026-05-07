import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';

/**
 * task-046 iter4 (K1): Discord-parity weekly DnD schedule.
 *
 * shape: { days: DndEntry[] } 또는 null (= no schedule)
 *   day:       0 (Sun) ~ 6 (Sat)
 *   startMin:  0~1439 (분 단위, 자정으로부터)
 *   endMin:    0~1439
 *   start > end → overnight (예: 23:00 → 07:00)
 *
 * 정책:
 *  - 같은 day 의 entries 는 OR (어느 하나라도 활성이면 DnD)
 *  - schedule 이 null 이면 disabled
 *  - 정적 presence "dnd" 는 schedule 무관 — 별도 (User.presencePreference)
 *
 * 본 service 는 schema validation + isDndActive(now, schedule) 만 제공.
 * dispatcher 통합 (실제 알림 차단) 은 follow-up.
 */

export interface DndEntry {
  day: number;
  startMin: number;
  endMin: number;
}
export interface DndSchedule {
  days: DndEntry[];
}

const MAX_ENTRIES_PER_USER = 14;

@Injectable()
export class DndScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  static validate(raw: unknown): DndSchedule | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') {
      throw new Error('schedule must be an object or null');
    }
    const obj = raw as { days?: unknown };
    if (!Array.isArray(obj.days)) {
      throw new Error('schedule.days must be an array');
    }
    if (obj.days.length > MAX_ENTRIES_PER_USER) {
      throw new Error(`too many entries (max ${MAX_ENTRIES_PER_USER})`);
    }
    const validated: DndEntry[] = [];
    for (const e of obj.days) {
      if (typeof e !== 'object' || e === null) {
        throw new Error('each entry must be an object');
      }
      const r = e as { day?: unknown; startMin?: unknown; endMin?: unknown };
      if (typeof r.day !== 'number' || r.day < 0 || r.day > 6 || !Number.isInteger(r.day)) {
        throw new Error('entry.day must be 0..6');
      }
      if (
        typeof r.startMin !== 'number' ||
        r.startMin < 0 ||
        r.startMin > 1439 ||
        !Number.isInteger(r.startMin)
      ) {
        throw new Error('entry.startMin must be 0..1439');
      }
      if (
        typeof r.endMin !== 'number' ||
        r.endMin < 0 ||
        r.endMin > 1439 ||
        !Number.isInteger(r.endMin)
      ) {
        throw new Error('entry.endMin must be 0..1439');
      }
      if (r.startMin === r.endMin) {
        throw new Error('entry.startMin === endMin (zero-length window)');
      }
      validated.push({ day: r.day, startMin: r.startMin, endMin: r.endMin });
    }
    return { days: validated };
  }

  /**
   * Pure: 주어진 시각이 DnD window 안에 있는지 반환. UTC 기준이 아닌
   * 사용자 local timezone 가정 — caller 가 적절한 Date 를 전달.
   * (현재는 timezone-naive — server UTC 그대로 사용. UI 가 사용자 tz
   * 로 자체 변환하는 패턴을 따르고, follow-up 으로 tz 컬럼 추가 가능.)
   */
  static isActive(at: Date, schedule: DndSchedule | null): boolean {
    if (!schedule || schedule.days.length === 0) return false;
    const day = at.getUTCDay(); // 0..6
    const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
    for (const e of schedule.days) {
      if (e.day !== day) continue;
      if (e.startMin < e.endMin) {
        // same-day window
        if (minute >= e.startMin && minute < e.endMin) return true;
      } else {
        // overnight: 23:00 → 07:00 → matches if >= startMin OR < endMin
        if (minute >= e.startMin || minute < e.endMin) return true;
      }
    }
    return false;
  }

  async get(userId: string): Promise<DndSchedule | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dndSchedule: true },
    });
    if (!row) return null;
    return row.dndSchedule as DndSchedule | null;
  }

  async set(userId: string, raw: unknown): Promise<DndSchedule | null> {
    const validated = DndScheduleService.validate(raw);
    await this.prisma.user.update({
      where: { id: userId },
      data: { dndSchedule: validated as unknown as object },
    });
    return validated;
  }
}
