import type { ActivityFilter } from './useActivity';

/**
 * S47 (FR-MN-13): Activity Inbox 탭 — All / Mentions / Threads / DMs.
 *
 * PRD 의 4 탭을 기존 /me/activity 필터(S26)에 매핑한다(MentionRecord 미도입 —
 * 기존 UNION 경로 유지):
 *   All      → 'all'      (멘션 + 답글 + 반응 + DM + 친구요청 전부)
 *   Mentions → 'mentions' (mention kind)
 *   Threads  → 'replies'  (reply kind — 스레드 답글)
 *   DMs      → 'directs'  (direct kind — DM 멘션/메시지)
 */
export type InboxTab = 'all' | 'mentions' | 'threads' | 'dms';

export const INBOX_TABS: ReadonlyArray<{ id: InboxTab; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'mentions', label: '멘션' },
  { id: 'threads', label: '스레드' },
  { id: 'dms', label: 'DM' },
] as const;

/** 탭 → /me/activity 필터 리매핑. */
export function tabToFilter(tab: InboxTab): ActivityFilter {
  switch (tab) {
    case 'mentions':
      return 'mentions';
    case 'threads':
      return 'replies';
    case 'dms':
      return 'directs';
    case 'all':
    default:
      return 'all';
  }
}

/** 탭별 빈 상태(empty) 카피(PRD FR-MN-13 정본 문구). */
export function emptyCopyForTab(tab: InboxTab): string {
  switch (tab) {
    case 'mentions':
      return '멘션 알림이 없습니다';
    case 'threads':
      return '스레드 댓글 알림이 없습니다';
    case 'dms':
      return 'DM 알림이 없습니다';
    case 'all':
    default:
      return '아직 알림이 없습니다';
  }
}
