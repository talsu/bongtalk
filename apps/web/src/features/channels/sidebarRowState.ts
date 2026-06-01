/**
 * S22 (FR-RS-04 / FR-RS-05): 사이드바 채널 행 2계층 표시 결정 로직.
 *
 * 두 계층을 분리한다:
 *  1. unread bold + 왼쪽 pill (`qf-channel--unread`) — 비뮤트 + unreadCount>0.
 *  2. mention 숫자 뱃지 (`qf-badge--count`) — mentionCount>0 이면 항상 표시,
 *     **뮤트여도 노출**(FR-RS-05: 뮤트는 unread 표시만 억제, 멘션은 유지).
 *
 * 순수 함수로 빼 둬 컴포넌트 렌더 없이 단위 검증한다. 활성(현재 열린) 채널은
 * 호출부에서 count 를 0 으로 눌러 넘기므로 여기서는 muted 여부와 카운트만 본다.
 */
export interface SidebarRowInput {
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
}

export interface SidebarRowState {
  /** `qf-channel--unread` (bold + 좌측 pill) 적용 여부. */
  showUnreadStyle: boolean;
  /** 행 우측 `qf-badge--count` 에 표시할 멘션 수. 0 이면 뱃지 숨김. */
  mentionBadgeCount: number;
}

/**
 * FR-RS-04: unreadCount>0 && 비뮤트 → unread 스타일.
 * FR-RS-05: 뮤트 채널은 unread 스타일 억제. 단 mentionCount>0 이면 뱃지는 유지.
 */
export function deriveSidebarRowState(input: SidebarRowInput): SidebarRowState {
  const unread = input.unreadCount > 0;
  return {
    showUnreadStyle: unread && !input.muted,
    mentionBadgeCount: input.mentionCount > 0 ? input.mentionCount : 0,
  };
}
