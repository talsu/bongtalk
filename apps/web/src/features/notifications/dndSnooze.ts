/**
 * S48 (D06 / FR-MN-11): DND Snooze 프리셋 → 절대 종료 시각(ISO) 계산.
 *
 * 클라이언트가 브라우저 로컬 기준으로 종료 시각을 계산해 PATCH
 * /me/settings/notifications { dndUntil: ISO } 로 전송한다(신규 API 불요).
 *
 * 프리셋:
 *   - thirty_min / one_hour / two_hours: now + 상대 분.
 *   - tomorrow: 내일 오전 9시(로컬). 다기기/사람 직관의 "내일 아침까지".
 *   - custom: 호출자가 직접 ISO 를 산정(여기 미포함).
 *
 * 실제 push 스킵은 VAPID web-push 가 defer 라 미구현 — 본 슬라이스는 WS fanout
 * 멘션 억제(서버 dndUntil 게이트)만 적용한다.
 */
export type DndSnoozePreset = 'thirty_min' | 'one_hour' | 'two_hours' | 'tomorrow';

const RELATIVE_MIN: Record<'thirty_min' | 'one_hour' | 'two_hours', number> = {
  thirty_min: 30,
  one_hour: 60,
  two_hours: 120,
};

/** 프리셋 → 종료 시각(Date). now 주입(테스트 결정성 — 기본 현재 시각). */
export function snoozeUntil(preset: DndSnoozePreset, now: Date = new Date()): Date {
  if (preset === 'tomorrow') {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t;
  }
  return new Date(now.getTime() + RELATIVE_MIN[preset] * 60_000);
}

/** UI 라벨(폴라이트 한국어). */
export const SNOOZE_PRESET_OPTIONS: ReadonlyArray<{ value: DndSnoozePreset; label: string }> = [
  { value: 'thirty_min', label: '30분' },
  { value: 'one_hour', label: '1시간' },
  { value: 'two_hours', label: '2시간' },
  { value: 'tomorrow', label: '내일 오전' },
];
