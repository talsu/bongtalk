import type { PresencePreference } from '@qufox/shared-types';

/**
 * S76 (D14 / FR-PS-11): 클라이언트 DND 알림 억제 게이트 — pure helper.
 *
 * DND 상태에서는 배너(토스트)를 표시하지 않는다(백엔드 푸시 전송 스킵은 푸시 인프라가
 * MVP 밖이라 S76 미구현 — 클라 억제 게이트만). effective DND 판정은:
 *
 *   - presencePreference === 'dnd'  → 억제. 수동 DND(FR-P05) 뿐 아니라 DND **스케줄**
 *     활성도 포함된다 — 서버(DndScheduleService)가 스케줄 구간 진입 시 presencePreference 를
 *     'dnd' 로 auto-toggle 하고 GET /me/dnd-schedule 의 effective preference 로 내려주므로,
 *     클라는 그 한 값만 보면 스케줄/수동을 모두 커버한다(기존 인프라 재사용).
 *
 * 입력 preference 가 미정(null/undefined — 스케줄 미로딩)이면 억제하지 않는다(기본 통과 —
 * 정상 동작을 막지 않는 보수적 폴백).
 */
export function shouldSuppressNotificationToast(
  preference: PresencePreference | null | undefined,
): boolean {
  return preference === 'dnd';
}
