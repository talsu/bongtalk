import * as chrono from 'chrono-node';

/**
 * S80 (D15 / FR-SC-06) — /remind 자연어 시각 + 본문 파싱(순수 함수).
 *
 * 1차 경로는 chrono-node(영어 자연어: `tomorrow 10am`·`in 30 minutes`·`next monday 9am`).
 * 한국어는 chrono 가 약하므로 제한적 정규식 보조(`N분 후`·`N시간 후`·`내일 H시`)를 먼저
 * 시도하고, 실패하면 chrono 로 폴백한다.
 *
 * 입력 형태(FR-SC-06):
 *   `/remind <시각표현> <메시지>`     — 예: `in 30 minutes 회의 준비`
 *   `/remind "메시지" <시각표현>`      — 따옴표로 메시지를 명시(시각이 뒤).
 *   `/remind me to <메시지> <시각표현>` — Slack 스타일(`me to` 접두 제거).
 *
 * 반환:
 *   { ok: true, scheduledAt: Date, message: string }  — 파싱 성공(미래 시각).
 *   { ok: false }                                      — 파싱 실패(과거/모호/미인식).
 *
 * now 를 인자로 받아 상대 표현을 기준 시각에 고정한다(테스트 결정성).
 */
export type ReminderParseResult =
  | { ok: true; scheduledAt: Date; message: string }
  | { ok: false };

// /remind 구문 예시(EPHEMERAL 에러 안내에 노출).
export const REMINDER_SYNTAX_HINT =
  '예: `/remind in 30 minutes 회의 준비` · `/remind tomorrow 10am 약 먹기` · `/remind 내일 9시 운동`';

/** Slack 스타일 `me to <...>` 접두를 제거한다(있으면). */
function stripMePrefix(input: string): string {
  return input.replace(/^\s*me\s+to\s+/i, '').trim();
}

/** 한국어 정규식 보조 파싱. 인식하면 결과, 아니면 null. */
function parseKorean(input: string, now: Date): ReminderParseResult | null {
  const text = input.trim();
  // `N분 후 <메시지>` / `N시간 후 <메시지>`
  const rel = text.match(/^(\d{1,4})\s*(분|시간)\s*(후|뒤)\s+(.+)$/);
  if (rel) {
    const amount = Number(rel[1]);
    const unitMin = rel[2] === '시간' ? 60 : 1;
    const message = rel[4].trim();
    if (amount > 0 && message.length > 0) {
      return { ok: true, scheduledAt: new Date(now.getTime() + amount * unitMin * 60_000), message };
    }
  }
  // `내일 H시 <메시지>` (H 는 0–23)
  const tomorrow = text.match(/^내일\s*(\d{1,2})\s*시\s+(.+)$/);
  if (tomorrow) {
    const hour = Number(tomorrow[1]);
    const message = tomorrow[2].trim();
    if (hour >= 0 && hour <= 23 && message.length > 0) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(hour, 0, 0, 0);
      return { ok: true, scheduledAt: d, message };
    }
  }
  return null;
}

/**
 * 따옴표 메시지 추출. `"..."` 또는 `'...'` 로 감싼 메시지가 있으면 그 부분을 message 로,
 * 나머지를 시각표현 후보로 분리한다. 없으면 null.
 */
function extractQuotedMessage(input: string): { message: string; rest: string } | null {
  const m = input.match(/["'](.+?)["']/);
  if (!m) return null;
  const message = m[1].trim();
  const rest = (input.slice(0, m.index) + input.slice((m.index ?? 0) + m[0].length)).trim();
  if (message.length === 0) return null;
  return { message, rest };
}

export function parseReminder(rawText: string, now: Date): ReminderParseResult {
  const input = stripMePrefix(rawText.trim());
  if (input.length === 0) return { ok: false };

  // 0) 한국어 보조 파싱 우선(chrono 가 한국어를 오인식하지 않도록).
  const ko = parseKorean(input, now);
  if (ko) {
    if (ko.ok && ko.scheduledAt.getTime() <= now.getTime()) return { ok: false };
    return ko;
  }

  // 1) 따옴표 메시지가 있으면 시각표현/메시지를 명시 분리.
  const quoted = extractQuotedMessage(input);
  if (quoted) {
    const parsed = chrono.parse(quoted.rest, now, { forwardDate: true });
    if (parsed.length === 0) return { ok: false };
    const scheduledAt = parsed[0].start.date();
    if (scheduledAt.getTime() <= now.getTime()) return { ok: false };
    return { ok: true, scheduledAt, message: quoted.message };
  }

  // 2) chrono 로 시각표현을 찾고, 그 텍스트 범위를 입력에서 제거한 나머지를 메시지로 본다.
  const results = chrono.parse(input, now, { forwardDate: true });
  if (results.length === 0) return { ok: false };
  const first = results[0];
  const scheduledAt = first.start.date();
  if (scheduledAt.getTime() <= now.getTime()) return { ok: false };
  const matched = first.text;
  const idx = input.indexOf(matched);
  let message = input;
  if (idx >= 0) {
    message = (input.slice(0, idx) + input.slice(idx + matched.length)).trim();
  }
  // 시각표현만 있고 메시지가 비면 실패(무엇을 알릴지 모름).
  if (message.length === 0) return { ok: false };
  return { ok: true, scheduledAt, message };
}
