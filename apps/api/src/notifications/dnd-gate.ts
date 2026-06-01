import { DndScheduleService, type DndSchedule } from '../me/dnd-schedule.service';

/**
 * S28 (FR-P05): DND 알림 차단 게이트 — pure helper.
 *
 * 수신자의 effective DND 여부를 판정한다. effective DND 는:
 *   1) presencePreference === 'dnd' (수동 DND, FR-P05), 또는
 *   2) dndSchedule 의 현재 구간이 활성(FR-P06) — 자정 걸침은 isActive 가 처리.
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
}

export function isDndSuppressed(row: DndGateRow, at: Date): boolean {
  if (row.presencePreference === 'dnd') return true;
  return DndScheduleService.isActive(at, row.dndSchedule);
}
