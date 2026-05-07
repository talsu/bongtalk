/**
 * task-047 iter2 (K3): unread vs mention badge variant 분기.
 *
 * 045 부터 WorkspaceNav 가 data-mention / data-unread 속성으로 분기
 * 했으나, 분기 로직이 inline JSX 안에 있어 spec 작성 / 다른 surface
 * (모바일 tab bar / DM list) 에서 재사용 어려움. 본 helper 가 단일
 * source.
 */

export type BadgeVariant = 'none' | 'unread' | 'mention';

/**
 * count + mention flag 로 시각 variant 결정.
 *  - count = 0 → 'none' (badge 숨김)
 *  - count > 0 + mention → 'mention' (강조 색)
 *  - count > 0 + !mention → 'unread' (기본 색)
 */
export function badgeVariant(count: number, hasMention: boolean): BadgeVariant {
  if (count <= 0) return 'none';
  return hasMention ? 'mention' : 'unread';
}

/** 한국어 aria-label. screen reader 용. */
export function badgeAriaLabel(count: number, hasMention: boolean): string | null {
  const variant = badgeVariant(count, hasMention);
  if (variant === 'none') return null;
  if (variant === 'mention') return `읽지 않은 멘션 ${count}개`;
  return `읽지 않음 ${count}개`;
}

/** 99+ cap 의 표시용 텍스트. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  if (count > 99) return '99+';
  return String(count);
}
