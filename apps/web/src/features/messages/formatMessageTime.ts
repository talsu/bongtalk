/**
 * S06 (FR-MSG-12 / FR-MSG-11) — 메시지 타임스탬프 포맷터(클라이언트 전용 순수 함수).
 *
 * MessageItem 의 head 행 시각, continuation 행 hover gutter 시각, 그리고
 * MessageList 의 날짜 구분선 라벨이 모두 이 모듈을 공유합니다. 서버는 ISO
 * 8601 createdAt 만 내려주며, 표시 포맷은 전적으로 클라이언트가 계산합니다.
 *
 * "오늘 / 어제 / N일 전" 판정은 **시차(밀리초 차)** 가 아니라 **달력 일(로컬
 * 자정 경계)** 기준입니다. 즉 어젯밤 23:59 와 오늘 00:01 은 2분 차이지만
 * 서로 다른 달력 일이므로 "어제" 로 분류됩니다. now 의 로컬 자정을 기준
 * 자정으로 잡고, 대상 시각의 로컬 자정과의 일(day) 차이를 셉니다.
 *
 * clock24h 기본값은 한국 관례를 따라 true(24시간제)입니다. 사용자별
 * 12/24시간제 토글은 설정 store(D14, S73~S77) 영역으로, 현재는 store 가
 * 없으므로 본 모듈은 param 으로만 받고 호출부는 기본값을 사용합니다.
 * clock24h 설정 wiring 은 D14(S73~S77) 후속입니다.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 로컬 자정(00:00:00.000) 으로 절삭한 새 Date 를 반환합니다. */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * `target` 이 `now` 기준 며칠 전 달력 일인지 반환합니다(시차 아님).
 * 오늘=0, 어제=1, 그제=2 … 미래(시계 어긋남)는 음수.
 */
function calendarDaysAgo(target: Date, now: Date): number {
  const a = localMidnight(now).getTime();
  const b = localMidnight(target).getTime();
  return Math.round((a - b) / MS_PER_DAY);
}

/** 시(0-23)·분(0-59) → 'HH:MM'(24h, zero-pad). */
function formatClock24h(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 시·분 → '오전/오후 H:MM'(12h, 시는 zero-pad 없음, 분은 zero-pad). */
function formatClock12h(d: Date): string {
  const h24 = d.getHours();
  const meridiem = h24 < 12 ? '오전' : '오후';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${meridiem} ${h12}:${mm}`;
}

/** clock24h 여부에 따라 시각 부분만 포맷합니다(날짜 접두사 없음). */
export function formatClockPart(d: Date, clock24h: boolean): string {
  // invalid Date 방어 — throw/'NaN:NaN' 대신 빈 문자열.
  if (Number.isNaN(d.getTime())) return '';
  return clock24h ? formatClock24h(d) : formatClock12h(d);
}

/** 'YYYY년 MM월 DD일' (월·일 zero-pad). */
function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}년 ${m}월 ${day}일`;
}

export type FormatMessageTimeOptions = {
  /** 24시간제(기본 true) / 12시간제(false). 설정 wiring 은 D14 후속. */
  clock24h?: boolean;
  /** 미래 i18n 훅 — 현재 한국어 고정, 시그니처만 예약. */
  locale?: string;
};

/**
 * 메시지 head 행 시각 라벨을 계산합니다(FR-MSG-12).
 *   - 오늘    : clock24h ? 'HH:MM' : '오전/오후 H:MM'
 *   - 어제    : '어제 HH:MM'
 *   - 2~6일 전: 'N일 전 HH:MM'
 *   - 그 이전 : 'YYYY년 MM월 DD일'
 */
export function formatMessageTime(iso: string, now: Date, opts?: FormatMessageTimeOptions): string {
  const clock24h = opts?.clock24h ?? true;
  const target = new Date(iso);
  // invalid/누락 iso 방어 — 이전 toLocaleTimeString 은 'Invalid Date' 로 degrade
  // 했으므로 throw 회귀 방지. 빈 라벨로 안전 폴백(전체 리스트 렌더 보호).
  if (Number.isNaN(target.getTime())) return '';
  const daysAgo = calendarDaysAgo(target, now);
  const clock = formatClockPart(target, clock24h);

  if (daysAgo <= 0) return clock; // 오늘(또는 시계 어긋남 미래) → 시각만.
  if (daysAgo === 1) return `어제 ${clock}`;
  if (daysAgo >= 2 && daysAgo <= 6) return `${daysAgo}일 전 ${clock}`;
  return formatYmd(target);
}

/**
 * hover tooltip 용 ISO 8601 전체 문자열(FR-MSG-12). toLocaleString 이 아닌
 * 기계 판독 가능한 ISO 를 그대로 노출해 정밀 시각을 확인하게 합니다.
 */
export function formatMessageTimeISO(iso: string): string {
  const d = new Date(iso);
  // invalid iso 면 toISOString 이 RangeError 를 던지므로 가드(빈 문자열 폴백).
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 날짜 구분선 라벨(FR-MSG-11). '2026년 1월 1일' 형식 — FR-MSG-11 의 표기를
 * 따르되, 본 구현은 월·일을 zero-pad('YYYY년 MM월 DD일') 해 정렬을 맞춥니다.
 */
export function formatDayDivider(iso: string, _opts?: { locale?: string }): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : formatYmd(d);
}

/**
 * 두 ISO 시각이 같은 로컬 달력 일인지 판정합니다(FR-MSG-11 자정 경계 분리에
 * grouping.ts / MessageList 가 공유). 순수 함수라 단위 테스트 가능합니다.
 */
export function isSameLocalDay(isoA: string, isoB: string): boolean {
  const a = new Date(isoA);
  const b = new Date(isoB);
  // 한쪽이라도 invalid 면 같은 날로 볼 수 없음 → false(그룹 분리/구분선 삽입 안전측).
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 날짜 구분선 dedupe 용 안정 키('YYYY-MM-DD', 로컬 기준). 같은 날 메시지는
 * 같은 키를 가집니다.
 */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
