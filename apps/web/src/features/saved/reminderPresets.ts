// S53 (D10 / FR-PS-09): 리마인더 프리셋 시각 계산(순수 함수, 단위 테스트 대상).
//
// 프리셋 시각은 사용자 timezone(User.timezone — S28 기구현, 없으면 브라우저 tz)
// 기준으로 계산해 UTC ISO 로 서버에 전달한다. "30분 후 / 1시간 후" 는 tz 무관
// (now + delta), "내일 오전 9시 / 다음 주 월요일 오전 9시" 는 해당 tz 의 벽시계
// 기준이라 tz 를 고려해 계산한다.

export type ReminderPresetKey = 'in30m' | 'in1h' | 'tomorrow9am' | 'nextMonday9am' | 'custom';

export interface ReminderPreset {
  key: ReminderPresetKey;
  label: string;
}

// 직접 입력(custom)을 제외한 프리셋 메뉴 정의.
export const REMINDER_PRESETS: readonly ReminderPreset[] = [
  { key: 'in30m', label: '30분 후' },
  { key: 'in1h', label: '1시간 후' },
  { key: 'tomorrow9am', label: '내일 오전 9시' },
  { key: 'nextMonday9am', label: '다음 주 월요일 오전 9시' },
] as const;

/**
 * 주어진 `instant` 시점에 `timeZone` 에서 보이는 벽시계 구성요소를 추출한다.
 * Intl.DateTimeFormat 으로 tz 변환된 연/월/일/시/분/초 + 요일을 얻는다.
 */
function wallClockParts(
  instant: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  // hour '24' (자정) 정규화.
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

/**
 * `timeZone` 기준의 특정 벽시계(연/월/일/시/분)가 가리키는 UTC instant 를 구한다.
 * tz offset 을 직접 계산하지 않고, 후보 UTC 시각을 만들고 그 tz 벽시계와의 차이를
 * 보정하는 방식으로 DST 경계에서도 안정적이다(1회 보정으로 충분).
 */
function zonedWallClockToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  // 1차 추정: 입력 벽시계를 UTC 로 간주.
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  // 그 guess 가 tz 에서 보이는 벽시계.
  const seen = wallClockParts(new Date(guess), timeZone);
  const seenUtc = Date.UTC(
    seen.year,
    seen.month - 1,
    seen.day,
    seen.hour,
    seen.minute,
    seen.second,
  );
  // offset = (tz 벽시계 - guess). 원하는 벽시계를 얻으려면 guess 에서 offset 만큼 뺀다.
  const offset = seenUtc - guess;
  return new Date(guess - offset);
}

/**
 * 프리셋 키 → UTC ISO 문자열. `now` 와 `timeZone` 을 받아 결정론적으로 계산한다
 * (단위 테스트 시 now 고정 + tz 명시). custom 은 호출자가 datetime-local 값을
 * 직접 ISO 로 변환하므로 여기서 다루지 않는다(null 반환).
 */
export function computeReminderAt(
  key: ReminderPresetKey,
  now: Date,
  timeZone: string,
): string | null {
  if (key === 'in30m') return new Date(now.getTime() + 30 * 60_000).toISOString();
  if (key === 'in1h') return new Date(now.getTime() + 60 * 60_000).toISOString();
  if (key === 'tomorrow9am') {
    const today = wallClockParts(now, timeZone);
    // 내일 = 오늘 + 1일(벽시계 day 증가는 zonedWallClockToUtc 의 Date.UTC 가
    // 월말 롤오버를 처리). 오전 9시.
    return zonedWallClockToUtc(
      { year: today.year, month: today.month, day: today.day + 1, hour: 9, minute: 0 },
      timeZone,
    ).toISOString();
  }
  if (key === 'nextMonday9am') {
    const today = wallClockParts(now, timeZone);
    // 다음 주 월요일까지의 일수. 오늘이 월요일이면 7일 후(이번 주 월요일이 아니라
    // "다음 주" 월요일 — Slack parity). weekday: 0=일 … 1=월.
    let delta = (1 - today.weekday + 7) % 7; // 이번/오늘 기준 다음 월요일까지(0=오늘이 월)
    delta = delta === 0 ? 7 : delta; // 오늘이 월요일이면 다음 주 월요일.
    // 단, 오늘이 화~일이면 delta 는 "이번 주 또는 다가오는" 월요일이지만, "다음 주"
    // 의미를 위해 항상 다가오는 월요일이 이번 주에 속하면 +7 하지 않는다 — Slack 은
    // "다음 주 월요일" 을 가장 가까운 미래 월요일로 본다. 오늘이 월요일일 때만 +7.
    return zonedWallClockToUtc(
      { year: today.year, month: today.month, day: today.day + delta, hour: 9, minute: 0 },
      timeZone,
    ).toISOString();
  }
  return null;
}

/** 브라우저의 IANA timezone(예: "Asia/Seoul"). 실패 시 'UTC'. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
