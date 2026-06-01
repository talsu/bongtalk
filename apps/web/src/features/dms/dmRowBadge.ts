/**
 * S22 (FR-DM-15): DM 사이드바 미읽 배지 결정 로직.
 *
 * 정책은 FR-RS-05 와 동일: 비뮤트 DM 은 unreadCount 배지를 그대로 표시하고,
 * 뮤트 DM 은 unread 배지를 억제하고 @멘션 건수만 표시한다.
 *
 * 다만 현행 GET /me/dms 응답(DmListItem)은 채널 단위 unreadCount 만 제공하고
 * DM 별 mentionCount 는 노출하지 않는다(서버 contract 미포함). 따라서 mention
 * 입력이 없으면(`mentionCount` 생략) 뮤트 DM 은 배지를 띄우지 않는다. 추후
 * 서버가 DM mentionCount 를 실으면 이 함수에 그대로 흘려보내면 된다.
 *
 * 순수 함수 — DmShell(데스크톱) + MobileDmList 두 surface 가 동일 로직을 공유한다.
 */
export interface DmRowBadgeInput {
  unreadCount: number;
  muted: boolean;
  /** DM 별 @멘션 수. 서버 contract 가 아직 제공 안 하면 생략(=0). */
  mentionCount?: number;
}

/**
 * 표시할 배지 카운트. 0 이면 배지 숨김.
 *  - 비뮤트: unreadCount 그대로.
 *  - 뮤트: mentionCount 만(없으면 0 → 배지 숨김).
 */
export function deriveDmBadgeCount(input: DmRowBadgeInput): number {
  if (input.muted) {
    const m = input.mentionCount ?? 0;
    return m > 0 ? m : 0;
  }
  return input.unreadCount > 0 ? input.unreadCount : 0;
}

/** 99+ cap 표시 텍스트. count<=0 이면 빈 문자열(호출부가 배지 자체를 안 그림). */
export function dmBadgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}
