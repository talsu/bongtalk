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

/**
 * S46 (D06 / ADR-6 / FR-MN-08): NotifLevel × isMuted → 사이드바 표시 규칙.
 *
 * ADR-6 배지 표(정본 — D06 본문 표와 불일치 시 ADR-6 정규화를 따른다):
 *   NotifLevel | isMuted=false                  | isMuted=true (muteUntil 미만)
 *   ALL        | 배지 O · 미읽 O · 푸시 O        | 배지 O · 미읽 O · 푸시 X
 *   MENTIONS   | 배지(멘션) O · 미읽 O · 푸시(멘션) O | 배지(멘션) O · 미읽 O · 푸시 X
 *   NOTHING    | 배지 X · 미읽 X · 푸시 X        | 배지 X · 미읽 X · 푸시 X
 *
 * 즉 ADR-6 에서 배지/미읽을 완전히 숨기는 단일 트리거는 **NOTHING** 이다.
 * isMuted 는 push 만 끄고 배지/미읽은 유지한다(D06 본문 표의 "배지 완전 숨김"과
 * 어긋나나 ADR-6 정본을 따른다 — REPORT 의 deviation 명시).
 *
 * 단, 본 프로젝트의 채널 뮤트(S43)는 UserChannelMute 행 존재(mutedUntil)로 미읽
 * 볼드를 억제해 왔다(deriveSidebarRowState.muted). 그 기존 UX 는 S43 helper 가
 * 계속 담당하고, 본 helper 는 NotifLevel 기준의 ADR-6 정규화 표를 단일 출처로
 * 노출해 설정 화면/배지 surface 가 동일 규칙을 공유하게 한다.
 */
export type NotifLevelValue = 'ALL' | 'MENTIONS' | 'NOTHING';

export interface NotifDisplay {
  /** 사이드바에 unread/mention 배지를 표시할지(NOTHING 이면 false). */
  showBadge: boolean;
  /** 미읽 볼드/pill 을 표시할지(NOTHING 이면 false). */
  showUnreadStyle: boolean;
  /** push 알림을 보낼지(NOTHING 또는 isMuted 면 false). */
  push: boolean;
}

export function notifDisplay(level: NotifLevelValue, isMuted: boolean): NotifDisplay {
  if (level === 'NOTHING') {
    return { showBadge: false, showUnreadStyle: false, push: false };
  }
  // ALL / MENTIONS: 배지·미읽 유지. push 는 isMuted 시 차단(만료 전 한정 — 호출부가
  // muteUntil 만료를 query-time 에 거른 뒤 isMuted 를 넘긴다).
  return { showBadge: true, showUnreadStyle: true, push: !isMuted };
}
