/**
 * S22 (FR-RS-15): 워크스페이스 서버 버튼 멘션 뱃지 결정 로직.
 *
 * 서버 버튼(qf-server-btn)의 `qf-server-btn__unread` 뱃지는 해당 워크스페이스의
 * unread 유무 + 멘션 합산으로 결정한다. 종전(task-018-E/047)엔 unreadCount>0 면
 * 무조건 뱃지를 띄우고 mention 여부로 색만 분기했다. S22 는 서버 합산 mentionCount
 * 를 surface 해 멘션 뱃지의 숫자/aria 를 멘션 건수 기준으로 노출한다.
 *
 * 표시 규칙(기존 UX 유지 + 멘션 우선):
 *  - mentionCount>0 → 'mention' variant, 표시 숫자 = mentionCount(99+ cap).
 *  - mentionCount=0 && unreadCount>0 → 'unread' variant, 숫자 표기 없이 점 의미의
 *    카운트(기존과 동일하게 unreadCount 노출 — DS qf-server-btn__unread 는 숫자 칩).
 *  - 둘 다 0 → 뱃지 없음.
 *
 * 순수 함수 — WorkspaceNav 렌더와 분리해 단위 검증한다. S21 summarizeWorkspaceTotals
 * → GET /me/unread-totals → useWorkspaceUnreadTotals 가 공급하는 합산을 그대로 쓴다.
 */
export type ServerButtonVariant = 'none' | 'unread' | 'mention';

export interface ServerButtonBadgeInput {
  unreadCount: number;
  mentionCount: number;
}

export interface ServerButtonBadge {
  variant: ServerButtonVariant;
  /** 뱃지에 그릴 숫자. variant==='none' 이면 0. */
  count: number;
}

export function deriveServerButtonBadge(input: ServerButtonBadgeInput): ServerButtonBadge {
  if (input.mentionCount > 0) {
    return { variant: 'mention', count: input.mentionCount };
  }
  if (input.unreadCount > 0) {
    return { variant: 'unread', count: input.unreadCount };
  }
  return { variant: 'none', count: 0 };
}

/** 99+ cap 표시 텍스트. count<=0 이면 빈 문자열. */
export function serverButtonBadgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/** 한국어 aria-label. variant 에 따라 멘션/미읽음 구분. */
export function serverButtonBadgeAria(badge: ServerButtonBadge): string | null {
  if (badge.variant === 'none') return null;
  if (badge.variant === 'mention') return `읽지 않은 멘션 ${badge.count}개`;
  return `읽지 않음 ${badge.count}개`;
}
