import { Injectable } from '@nestjs/common';
import { PresencePreference, Prisma } from '@prisma/client';
import type { DndEntry, DndSchedule } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

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

// contract HIGH fix-forward: shape 의 단일 출처는 @qufox/shared-types 다(api/web
// drift 제거). 기존 내부 import 경로 호환을 위해 type 만 re-export 한다.
export type { DndEntry, DndSchedule } from '@qufox/shared-types';

const MAX_ENTRIES_PER_USER = 14;

/**
 * S48 fix-forward(perf): timezone 별 Intl.DateTimeFormat 캐시. @everyone fanout 시
 * 수신자마다 localDayMinute 가 호출되면 동일 timezone 에 대해 포매터를 N회 생성하게
 * 된다(Intl 생성은 비교적 무겁다). module-level Map 으로 timezone → formatter 를
 * 재사용해 인스턴스 생성을 1회/timezone 으로 줄인다. 키 공간이 IANA 이름(유한)이라
 * 무한 증식하지 않는다.
 */
const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();

function dayMinuteFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = DTF_CACHE.get(timezone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  DTF_CACHE.set(timezone, fmt);
  return fmt;
}

@Injectable()
export class DndScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * task-047 iter0 (MED-046-4): raw `Error` 대신 `DomainError(VALIDATION_FAILED)`
   * 사용 — 도메인 에러 계층 + errorCode enum 컨벤션 (CLAUDE.md). 클라이언트가
   * 구조화된 400 + errorCode 받을 수 있도록 함.
   */
  static validate(raw: unknown): DndSchedule | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'schedule must be an object or null');
    }
    const obj = raw as { days?: unknown };
    if (!Array.isArray(obj.days)) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'schedule.days must be an array');
    }
    if (obj.days.length > MAX_ENTRIES_PER_USER) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `too many entries (max ${MAX_ENTRIES_PER_USER})`,
      );
    }
    const validated: DndEntry[] = [];
    for (const e of obj.days) {
      if (typeof e !== 'object' || e === null) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'each entry must be an object');
      }
      const r = e as { day?: unknown; startMin?: unknown; endMin?: unknown };
      if (typeof r.day !== 'number' || r.day < 0 || r.day > 6 || !Number.isInteger(r.day)) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'entry.day must be 0..6');
      }
      if (
        typeof r.startMin !== 'number' ||
        r.startMin < 0 ||
        r.startMin > 1439 ||
        !Number.isInteger(r.startMin)
      ) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'entry.startMin must be 0..1439');
      }
      if (
        typeof r.endMin !== 'number' ||
        r.endMin < 0 ||
        r.endMin > 1439 ||
        !Number.isInteger(r.endMin)
      ) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'entry.endMin must be 0..1439');
      }
      if (r.startMin === r.endMin) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'entry.startMin === endMin (zero-length window)',
        );
      }
      validated.push({ day: r.day, startMin: r.startMin, endMin: r.endMin });
    }
    return { days: validated };
  }

  /**
   * S48 (FR-MN-12): 주어진 UTC 시각을 사용자 IANA timezone 의 로컬 요일/분으로 변환한다.
   * 신규 의존성 없이 built-in `Intl.DateTimeFormat`(timeZone 옵션)만 사용해 DST 를
   * 포함한 정확한 offset 을 얻는다(date-fns-tz/Luxon 미도입 — 변환에 필요한 weekday +
   * hour + minute 만 필요해 표준 API 로 충분). timezone 이 null/빈 문자열이거나
   * 잘못된 IANA 이름이면 UTC 로 폴백한다(throw 회피 — 게이트는 보수적으로 동작).
   *
   * @returns { day: 0(Sun)~6(Sat), minute: 0~1439 } — 해당 timezone 로컬 기준.
   */
  static localDayMinute(
    at: Date,
    timezone: string | null | undefined,
  ): { day: number; minute: number } {
    if (!timezone) {
      return { day: at.getUTCDay(), minute: at.getUTCHours() * 60 + at.getUTCMinutes() };
    }
    try {
      // S48 fix-forward(perf): timezone 별 포매터 캐시 재사용(fanout 시 N회 생성 제거).
      const parts = dayMinuteFormatter(timezone).formatToParts(at);
      const lookup = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
      const weekdayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      const day = weekdayMap[lookup('weekday')];
      // hour12:false 일부 런타임은 자정을 '24' 로 내보낸다 — 0 으로 정규화.
      const hour = Number(lookup('hour')) % 24;
      const minute = Number(lookup('minute'));
      if (day === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
        return { day: at.getUTCDay(), minute: at.getUTCHours() * 60 + at.getUTCMinutes() };
      }
      return { day, minute: hour * 60 + minute };
    } catch {
      // 잘못된 IANA 이름 등 — UTC 폴백.
      return { day: at.getUTCDay(), minute: at.getUTCHours() * 60 + at.getUTCMinutes() };
    }
  }

  /**
   * Pure: 주어진 시각이 DnD window 안에 있는지 반환. timezone 이 주어지면 at 을
   * 사용자 IANA 로컬 요일/분으로 변환해 판정한다(FR-MN-12). 미지정이면 server UTC
   * 그대로 사용(기존 동작 — UI 가 사용자 tz 로 자체 변환하던 패턴과 호환).
   */
  static isActive(at: Date, schedule: DndSchedule | null, timezone?: string | null): boolean {
    if (!schedule || schedule.days.length === 0) return false;
    const { day, minute } = DndScheduleService.localDayMinute(at, timezone);
    // S28 (reviewer B1 BLOCKER fix): overnight(startMin>endMin) 구간의 "다음날
    // 새벽 carry" 누락을 닫는다. 이전 구현은 `e.day !== day` 로 skip 해서, Wed
    // 23:00→07:00 entry 가 Thu 03:00(다음날 새벽)에 매칭되지 않았다(자정 이후
    // 구간이 사라짐). 두 가지로 분리해 평가한다:
    //   • 주간(startMin<endMin): 같은 요일의 [start, end).
    //   • 자정걸침(startMin>endMin): 오늘 요일 entry 의 저녁 부분(min≥start) OR
    //     **전날 요일** entry 의 새벽 carry(min<end). 전날 = (day+6)%7.
    //   • startMin===endMin 은 validate 가 거른 0-length 라 여기 도달하지 않으나
    //     도달 시 비활성으로 둔다(보수적).
    const prevDay = (day + 6) % 7;
    for (const e of schedule.days) {
      if (e.startMin < e.endMin) {
        // same-day window — 오늘 요일 entry 만.
        if (e.day === day && minute >= e.startMin && minute < e.endMin) return true;
      } else if (e.startMin > e.endMin) {
        // overnight: 저녁 부분(오늘 요일 entry) OR 새벽 carry(전날 요일 entry).
        if (e.day === day && minute >= e.startMin) return true;
        if (e.day === prevDay && minute < e.endMin) return true;
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

  /**
   * S28 (FR-P06): 스케줄 auto-toggle. 한 사용자에 대해 현재 시각이 DND 구간
   * 안인지 평가하고, 진입/종료 전이를 presencePreference 에 반영한다.
   *
   * 정책:
   *  - **진입**(밖→안): 직전 presencePreference 를 dndScheduleSnapshot.prev 에 보관하고
   *    presencePreference 를 dnd 로 강제한다. 단 직전이 이미 dnd 면 사용자 수동 DND
   *    이거나 이미 스케줄 DND 이므로 snapshot 을 만들지 않고 멱등 처리한다.
   *  - **종료**(안→밖): snapshot 이 있으면 prev 로 복원하고 snapshot 을 비운다.
   *    snapshot 이 없으면(수동 DND 등 스케줄이 만든 게 아님) 건드리지 않는다.
   *  - 자정 걸침(start>end)은 isActive 가 (now≥start OR now<end)로 이미 처리한다.
   *
   * "스케줄이 만든 DND 인가"는 snapshot 존재 여부로 판별한다. 사용자가 구간 중
   * 수동으로 invisible 등으로 바꾸면 snapshot 은 그대로 남고, 종료 시 그 invisible 을
   * 그대로 복원하는 대신 snapshot.prev(진입 전 값)로 되돌린다 — 스케줄 종료의
   * 직관(원래 상태로) 우선. 전이가 없으면 DB write 를 하지 않는다(no-op).
   *
   * @returns 변경 후 effective preference + 전이 종류.
   */
  async evaluateAndApply(
    userId: string,
    at: Date = new Date(),
  ): Promise<{
    preference: PresencePreference;
    transition: 'entered' | 'exited' | 'none';
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        presencePreference: true,
        dndSchedule: true,
        dndScheduleSnapshot: true,
        timezone: true,
      },
    });
    if (!row) return { preference: 'auto', transition: 'none' };

    const schedule = (row.dndSchedule as DndSchedule | null) ?? null;
    // S48 (FR-MN-12): 스케줄 평가도 사용자 timezone 기준(fanout 게이트와 정합).
    const active = DndScheduleService.isActive(at, schedule, row.timezone);
    const snapshot = DndScheduleService.parseSnapshot(row.dndScheduleSnapshot);
    const scheduleOwnsDnd = snapshot !== null;

    if (active && !scheduleOwnsDnd) {
      // 진입: 직전이 이미 dnd 면 멱등(스냅샷 없이 dnd 유지) — 단 수동 DND 와
      // 구분 위해 스냅샷을 만들지 않는다(종료 시 수동 DND 를 끄지 않기 위함).
      if (row.presencePreference === 'dnd') {
        return { preference: 'dnd', transition: 'none' };
      }
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          presencePreference: 'dnd',
          dndScheduleSnapshot: { prev: row.presencePreference } as unknown as object,
        },
      });
      return { preference: 'dnd', transition: 'entered' };
    }

    if (!active && scheduleOwnsDnd) {
      // 종료: 스냅샷이 만든 DND 만 복원. prev 가 유효하지 않으면 auto 로.
      const prev = snapshot.prev;
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          presencePreference: prev,
          dndScheduleSnapshot: Prisma.JsonNull,
        },
      });
      return { preference: prev, transition: 'exited' };
    }

    return { preference: row.presencePreference, transition: 'none' };
  }

  /** dndScheduleSnapshot JSON 을 안전 파싱. shape: { prev: PresencePreference }. */
  static parseSnapshot(raw: unknown): { prev: PresencePreference } | null {
    if (raw === null || raw === undefined || typeof raw !== 'object') return null;
    const r = raw as { prev?: unknown };
    if (r.prev === 'auto' || r.prev === 'dnd' || r.prev === 'invisible') {
      return { prev: r.prev };
    }
    return null;
  }
}
