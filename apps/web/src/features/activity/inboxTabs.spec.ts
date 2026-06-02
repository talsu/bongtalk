import { describe, it, expect } from 'vitest';
import { INBOX_TABS, tabToFilter, emptyCopyForTab } from './inboxTabs';

/**
 * S47 (FR-MN-13): Activity Inbox 탭 리매핑 + 탭별 empty 카피.
 */
describe('inboxTabs (S47 · FR-MN-13)', () => {
  it('4개 탭(All/Mentions/Threads/DMs)을 노출한다', () => {
    expect(INBOX_TABS.map((t) => t.id)).toEqual(['all', 'mentions', 'threads', 'dms']);
  });

  it('탭 → /me/activity 필터 리매핑(threads=replies · dms=directs)', () => {
    expect(tabToFilter('all')).toBe('all');
    expect(tabToFilter('mentions')).toBe('mentions');
    expect(tabToFilter('threads')).toBe('replies');
    expect(tabToFilter('dms')).toBe('directs');
  });

  it('탭별 empty 카피가 PRD 문구와 일치한다', () => {
    expect(emptyCopyForTab('all')).toBe('아직 알림이 없습니다');
    expect(emptyCopyForTab('mentions')).toBe('멘션 알림이 없습니다');
    expect(emptyCopyForTab('threads')).toBe('스레드 댓글 알림이 없습니다');
    expect(emptyCopyForTab('dms')).toBe('DM 알림이 없습니다');
  });
});
