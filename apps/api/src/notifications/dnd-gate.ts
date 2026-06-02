import { DndScheduleService, type DndSchedule } from '../me/dnd-schedule.service';

/**
 * S28 (FR-P05): DND 알림 차단 게이트 — pure helper.
 *
 * 수신자의 effective DND 여부를 판정한다. effective DND 는:
 *   1) presencePreference === 'dnd' (수동 DND, FR-P05), 또는
 *   2) dndUntil 임시 snooze 가 활성(FR-MN-11) — at < dndUntil 이면 DND. dndUntil
 *      이 과거면 query-time 에 만료로 본다(별도 cron 불요 — isMuteActive 패턴), 또는
 *   3) dndSchedule 의 현재 구간이 활성(FR-P06) — 자정 걸침은 isActive 가 처리.
 *
 * DND 인 수신자에게는 멘션/채널 알림(mention.received 등)을 **브로드캐스트 단계에서**
 * 미발송한다. mute 게이트와 동일하게 outbox emit 직전에 후보 목록을 거른다.
 *
 * 우선순위 bypass(priority.ts 의 bypassesMute) 는 DND 에는 적용하지 않는다 —
 * DND 는 사용자가 명시적으로 "방해 금지"를 켠 상태이므로 high priority 도 차단한다
 * (Discord/Slack parity). digest/배지 카운트는 별도 경로라 영향받지 않는다.
 */
export interface DndGateRow {
  presencePreference: 'auto' | 'dnd' | 'invisible';
  dndSchedule: DndSchedule | null;
  /**
   * S48 (FR-MN-11): 임시 DND snooze 종료 시각(UserSettings.dndUntil). null/미지정 =
   * snooze 없음. at < dndUntil 이면 DND 활성, 도달/초과(at >= dndUntil)면 만료로 본다
   * (query-time 만료 — cron 불요). dndSchedule 보다 사용자 timezone 변환 비용이 없어
   * presencePreference 다음, dndSchedule 앞에서 평가한다.
   */
  dndUntil?: Date | null;
  /**
   * S48 (FR-MN-12): 수신자의 IANA timezone(User.timezone). dndSchedule 평가 시 at 을
   * 사용자 로컬 시각으로 변환하는 데 쓴다. null/미지정 = UTC 로 평가(기존 동작).
   */
  timezone?: string | null;
}

export function isDndSuppressed(row: DndGateRow, at: Date): boolean {
  if (row.presencePreference === 'dnd') return true;
  // FR-MN-11: snooze. 만료 시각이 미래면 차단(경계 at===dndUntil 은 해제).
  if (row.dndUntil && row.dndUntil.getTime() > at.getTime()) return true;
  // FR-MN-12: 스케줄은 사용자 timezone 기준으로 평가.
  return DndScheduleService.isActive(at, row.dndSchedule, row.timezone ?? null);
}
