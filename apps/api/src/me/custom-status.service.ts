import { Injectable } from '@nestjs/common';
import type { CustomStatusView, StatusPreset } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { PresenceService } from '../realtime/presence/presence.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S28 (FR-P04 + FR-P17): Discord-parity 구조화 커스텀 상태.
 *
 * 데이터 모델(User):
 *   customStatus          — 텍스트(기존 컬럼 재사용, max 100). null = 없음.
 *   customStatusEmoji     — 이모지 또는 :shortcode: (max 64). null = 없음.
 *   customStatusExpiresAt — 만료 시각(UTC). null = 무기한.
 *   timezone              — IANA tz(프리셋 계산 기준). null = 미설정.
 *
 * FR-P04 프리셋('오늘 자정'/30분/1시간/이번주 등)은 **클라이언트가** 자신의
 * timezone 으로 계산해 절대 UTC ISO 로 전송하는 것을 1차 경로로 삼는다(브라우저
 * tz 가 가장 신뢰도 높음). 다만 timezone 을 저장해 두면 서버 측 프리셋 계산
 * (cron/digest 등 클라 없는 컨텍스트)에서도 동일 기준을 쓸 수 있도록
 * `computePreset` 를 pure helper 로 노출한다.
 *
 * FR-P17 만료 스케줄러: BullMQ 부재 → **read-time lazy clear**. `getEffective`
 * 가 expiresAt < now 면 빈 상태를 반환하고(부수효과 없이) 비동기로 DB 를 정리한다.
 * 선택적 cron 은 후속(DEFER) — lazy 가 정합성의 단일 출처다.
 */

// contract HIGH fix-forward: StatusPreset / CustomStatusView 의 단일 출처는
// @qufox/shared-types 다(api/web drift 제거). 내부 import 경로 호환을 위해
// type 만 re-export 한다.
export type { CustomStatusView, StatusPreset } from '@qufox/shared-types';

const TEXT_MAX = 100;
const EMOJI_MAX = 64;
const TZ_MAX = 64;

/**
 * S28 (security MED 방어): text/emoji 에서 제어문자(C0/C1 + DEL)를 제거한다.
 * React 렌더가 1차 XSS 방어이나, 보이지 않는 제어문자가 저장/노출되어 로그
 * 오염·렌더 깨짐·스푸핑에 쓰이는 것을 입력 경계에서 막는다(방어적). 일반 텍스트
 * (이모지·CJK 포함)는 그대로 통과한다.
 */
export function stripControlChars(value: string): string {
  // C0 (U+0000–U+001F) + DEL (U+007F) + C1 (U+0080–U+009F).
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/**
 * S28 (HIGH-2 + FR-P17): 만료 마스킹 — 노출 경로(멤버목록·DM·broadcast)가 공유한다.
 * expiresAt 이 now 이하이면 만료로 보고 text/emoji 를 null 로 가린다. getEffective
 * 와 동일한 판정 기준이다(만료분 비노출 단일 규칙). DB 정리는 호출측의 lazy clear
 * 또는 다음 set 에 위임한다(이 helper 는 부수효과 없는 pure).
 */
export function maskExpiredStatus(input: {
  text: string | null;
  emoji: string | null;
  expiresAt: Date | null;
  now: Date;
}): { text: string | null; emoji: string | null } {
  if (input.expiresAt && input.expiresAt.getTime() <= input.now.getTime()) {
    return { text: null, emoji: null };
  }
  return { text: input.text, emoji: input.emoji };
}

@Injectable()
export class CustomStatusService {
  constructor(
    private readonly prisma: PrismaService,
    // S74 (FR-PS-05 · Fork1 Option C): 만료 시 DND 활성화에 presencePreference 전환 +
    // Redis dnd SET 동기를 위해 PresenceService 를 쓴다.
    private readonly presence: PresenceService,
  ) {}

  /**
   * IANA timezone 유효성 검증 — Intl 의 timeZone 옵션이 던지는지로 판정.
   * 잘못된 tz 는 RangeError 를 던진다.
   */
  static isValidTimezone(tz: string): boolean {
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 프리셋 → 만료 UTC Date 계산. `now` 와 IANA `timezone` 기준.
   *  - dont_clear → null(무기한)
   *  - thirty_min / one_hour / four_hours → now + Δ (tz 무관)
   *  - today → 사용자 tz 의 "오늘 자정(다음날 00:00)" 을 UTC 로
   *  - this_week → 사용자 tz 의 "이번 주 일요일 자정(다음 일요일 00:00)" 을 UTC 로
   *
   * timezone 미지정 시 'UTC' 로 계산한다(클라가 이미 계산했다면 직접 expiresAt 을
   * 보내므로 이 경로는 fallback).
   */
  static computePreset(preset: StatusPreset, now: Date, timezone: string | null): Date | null {
    switch (preset) {
      case 'dont_clear':
        return null;
      case 'thirty_min':
        return new Date(now.getTime() + 30 * 60_000);
      case 'one_hour':
        return new Date(now.getTime() + 60 * 60_000);
      case 'four_hours':
        return new Date(now.getTime() + 4 * 60 * 60_000);
      case 'today':
        return CustomStatusService.nextMidnightUtc(now, timezone ?? 'UTC', 0);
      case 'this_week': {
        // tz 기준 "다음 일요일 00:00" 까지. nextMidnightUtc 는 (오늘+1+addDays)
        // 자정을 주므로, 다음 일요일까지의 총 일수(7-dow, dow=0이면 7)에서 1을 뺀
        // 값을 addDays 로 넘긴다. 예: Wed(dow=3) → 총 4일 → addDays=3 →
        // 오늘+4 자정 = 다음 일요일 00:00.
        const dow = CustomStatusService.zonedDayOfWeek(now, timezone ?? 'UTC');
        const totalDays = dow === 0 ? 7 : 7 - dow;
        return CustomStatusService.nextMidnightUtc(now, timezone ?? 'UTC', totalDays - 1);
      }
      default:
        // S28 (security HIGH-1 fix): 사용자 입력(preset)을 에러 메시지에 반영하지
        // 않는다(reflected-input). 허용 값 목록만 담은 고정 문자열을 던진다.
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'preset must be one of: dont_clear|thirty_min|one_hour|four_hours|today|this_week',
        );
    }
  }

  /**
   * 주어진 tz 에서 `now` 가 속한 날짜의 (00:00 + addDays) 자정을 UTC Date 로.
   * tz offset 을 분 단위로 구해 역산한다(DST 경계는 근사 — 분 단위 정확도면 충분).
   */
  private static nextMidnightUtc(now: Date, timezone: string, addDays: number): Date {
    const parts = CustomStatusService.zonedParts(now, timezone);
    const offsetMin = CustomStatusService.tzOffsetMinutes(now, timezone);
    // tz 로컬 자정(다음날 00:00 + addDays)을 UTC epoch 로 환산.
    // 로컬 자정의 UTC = Date.UTC(localY, localMo, localD + 1 + addDays, 0,0) - offset
    const localMidnightUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + 1 + addDays,
      0,
      0,
      0,
    );
    return new Date(localMidnightUtcMs - offsetMin * 60_000);
  }

  private static zonedDayOfWeek(now: Date, timezone: string): number {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
      now,
    );
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
  }

  private static zonedParts(
    now: Date,
    timezone: string,
  ): { year: number; month: number; day: number } {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const out: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    return {
      year: Number(out.year),
      month: Number(out.month),
      day: Number(out.day),
    };
  }

  /** tz offset(분) = (zoned wall clock) - (UTC wall clock). 예: Asia/Seoul → +540. */
  private static tzOffsetMinutes(now: Date, timezone: string): number {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const out: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) {
      if (p.type !== 'literal') out[p.type] = p.value;
    }
    let hour = Number(out.hour);
    if (hour === 24) hour = 0; // some engines emit 24 for midnight
    const asUtc = Date.UTC(
      Number(out.year),
      Number(out.month) - 1,
      Number(out.day),
      hour,
      Number(out.minute),
      Number(out.second),
    );
    return Math.round((asUtc - now.getTime()) / 60_000);
  }

  /**
   * 입력 정규화 + 검증. text/emoji 트림 + cap, expiresAt 은 미래 UTC 이거나 null.
   * preset 이 오면 timezone 기준으로 expiresAt 을 계산한다(expiresAt 직접 지정과
   * 동시 지정 시 expiresAt 우선 — 클라 계산을 신뢰).
   */
  static normalizeInput(
    body: {
      text?: unknown;
      emoji?: unknown;
      expiresAt?: unknown;
      preset?: unknown;
      timezone?: unknown;
    },
    now: Date,
  ): {
    text: string | null;
    emoji: string | null;
    expiresAt: Date | null;
    timezone: string | null;
  } {
    // text
    let text: string | null;
    const rawText = body.text;
    if (rawText === null || rawText === undefined || rawText === '') {
      text = null;
    } else if (typeof rawText !== 'string') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'text must be a string or null');
    } else {
      // S28 (MED 방어): trim 후 제어문자 제거 → 그 결과로 cap/빈값 판정.
      const t = stripControlChars(rawText).trim();
      if (t.length === 0) text = null;
      else if (t.length > TEXT_MAX)
        throw new DomainError(ErrorCode.VALIDATION_FAILED, `text too long (max ${TEXT_MAX})`);
      else text = t;
    }

    // emoji
    let emoji: string | null;
    const rawEmoji = body.emoji;
    if (rawEmoji === null || rawEmoji === undefined || rawEmoji === '') {
      emoji = null;
    } else if (typeof rawEmoji !== 'string') {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'emoji must be a string or null');
    } else {
      // S28 (MED 방어): trim 후 제어문자 제거 → 그 결과로 cap/빈값 판정.
      const e = stripControlChars(rawEmoji).trim();
      if (e.length === 0) emoji = null;
      else if (e.length > EMOJI_MAX)
        throw new DomainError(ErrorCode.VALIDATION_FAILED, `emoji too long (max ${EMOJI_MAX})`);
      else emoji = e;
    }

    // timezone (optional — 저장 시 프리셋 기준)
    let timezone: string | null = null;
    const rawTz = body.timezone;
    if (rawTz !== null && rawTz !== undefined && rawTz !== '') {
      if (typeof rawTz !== 'string' || rawTz.length > TZ_MAX) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, `timezone invalid (max ${TZ_MAX})`);
      }
      if (!CustomStatusService.isValidTimezone(rawTz)) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, `timezone is not a valid IANA zone`);
      }
      timezone = rawTz;
    }

    // expiresAt: explicit ISO 우선, 없으면 preset 으로 계산.
    let expiresAt: Date | null = null;
    const rawExp = body.expiresAt;
    if (rawExp !== null && rawExp !== undefined) {
      if (typeof rawExp !== 'string') {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'expiresAt must be an ISO string or null',
        );
      }
      const d = new Date(rawExp);
      if (Number.isNaN(d.getTime())) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'expiresAt is not a valid ISO date');
      }
      if (d.getTime() <= now.getTime()) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'expiresAt must be in the future');
      }
      expiresAt = d;
    } else if (body.preset !== null && body.preset !== undefined) {
      const preset = body.preset;
      if (typeof preset !== 'string') {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'preset must be a string');
      }
      expiresAt = CustomStatusService.computePreset(preset as StatusPreset, now, timezone);
    }

    return { text, emoji, expiresAt, timezone };
  }

  /** GET — lazy 만료 적용한 현재 상태. */
  async getEffective(userId: string, now: Date = new Date()): Promise<CustomStatusView> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        customStatus: true,
        customStatusEmoji: true,
        customStatusExpiresAt: true,
        // S74 (FR-PS-05): 본인 read 에 옵션값 노출 + 만료 시 DND 활성화 판정.
        dndDuringStatus: true,
      },
    });
    if (!row) return { text: null, emoji: null, expiresAt: null };
    if (row.customStatusExpiresAt && row.customStatusExpiresAt.getTime() <= now.getTime()) {
      // FR-P17 lazy clear: 만료분은 빈 상태로 보이고, DB 도 best-effort 로 정리한다.
      // S74 (FR-PS-05 · Fork1 Option C): dndDuringStatus 옵션이 켜져 있으면 만료 시점에
      // DND 도 함께 활성화한다(best-effort — presence 전환 실패가 read 를 막지 않게 삼킨다).
      void this.clearAndMaybeDnd(userId, row.dndDuringStatus).catch(() => undefined);
      return {
        text: null,
        emoji: null,
        expiresAt: null,
        dndDuringStatus: row.dndDuringStatus,
      };
    }
    return {
      text: row.customStatus ?? null,
      emoji: row.customStatusEmoji ?? null,
      expiresAt: row.customStatusExpiresAt ? row.customStatusExpiresAt.toISOString() : null,
      dndDuringStatus: row.dndDuringStatus,
    };
  }

  /**
   * S74 (FR-PS-05): 만료 lazy-clear + (옵션 시) DND 활성화. clear 로 상태 컬럼을 비우고,
   * dndDuringStatus 가 true 면 사용자의 모든 워크스페이스에 presencePreference=dnd 를 적용한다
   * (PresenceService.setDndForUser — Redis dnd SET + preference 키 동기). 옵션 자체(컬럼)는
   * 보존한다(다음 상태 만료에서도 동일 동작 — 사용자 환경 설정).
   */
  async clearAndMaybeDnd(userId: string, dndDuringStatus: boolean): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { customStatus: null, customStatusEmoji: null, customStatusExpiresAt: null },
    });
    if (!dndDuringStatus) return;
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    await this.presence.setDndForUser(
      userId,
      memberships.map((m) => m.workspaceId),
      true,
    );
  }

  /**
   * PUT — 구조화 set/update. timezone 은 제공된 경우에만 갱신(없으면 유지).
   * S74 (FR-PS-05): dndDuringStatus 가 입력에 있으면 옵션 컬럼을 갱신한다(없으면 유지).
   */
  async set(
    userId: string,
    body: {
      text?: unknown;
      emoji?: unknown;
      expiresAt?: unknown;
      preset?: unknown;
      timezone?: unknown;
      dndDuringStatus?: unknown;
    },
    now: Date = new Date(),
  ): Promise<CustomStatusView> {
    const n = CustomStatusService.normalizeInput(body, now);
    // S74 (FR-PS-05): boolean 만 옵션으로 받는다(Zod 가 1차 검증 — 방어적 재확인).
    const dndOpt = typeof body.dndDuringStatus === 'boolean' ? body.dndDuringStatus : undefined;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        customStatus: n.text,
        customStatusEmoji: n.emoji,
        customStatusExpiresAt: n.expiresAt,
        ...(n.timezone !== null ? { timezone: n.timezone } : {}),
        ...(dndOpt !== undefined ? { dndDuringStatus: dndOpt } : {}),
      },
    });
    return {
      text: n.text,
      emoji: n.emoji,
      expiresAt: n.expiresAt ? n.expiresAt.toISOString() : null,
      dndDuringStatus: dndOpt,
    };
  }

  /** DELETE — 커스텀 상태 전체 클리어(timezone·dndDuringStatus 는 유지 — 사용자 환경 설정값). */
  async clear(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { customStatus: null, customStatusEmoji: null, customStatusExpiresAt: null },
    });
  }
}
