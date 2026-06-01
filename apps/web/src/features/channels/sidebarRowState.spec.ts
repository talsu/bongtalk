import { describe, it, expect } from 'vitest';
import { deriveSidebarRowState } from './sidebarRowState';

describe('deriveSidebarRowState (FR-RS-04 / FR-RS-05)', () => {
  it('FR-RS-04: 비뮤트 + unread>0 → unread 스타일 + 멘션 뱃지', () => {
    expect(deriveSidebarRowState({ unreadCount: 3, mentionCount: 2, muted: false })).toEqual({
      showUnreadStyle: true,
      mentionBadgeCount: 2,
    });
  });

  it('FR-RS-04: 비뮤트 + unread>0 + 멘션 0 → unread 스타일만', () => {
    expect(deriveSidebarRowState({ unreadCount: 5, mentionCount: 0, muted: false })).toEqual({
      showUnreadStyle: true,
      mentionBadgeCount: 0,
    });
  });

  it('unread 0 → 스타일 없음', () => {
    expect(deriveSidebarRowState({ unreadCount: 0, mentionCount: 0, muted: false })).toEqual({
      showUnreadStyle: false,
      mentionBadgeCount: 0,
    });
  });

  it('FR-RS-05: 뮤트 채널은 unread 스타일 억제', () => {
    expect(deriveSidebarRowState({ unreadCount: 7, mentionCount: 0, muted: true })).toEqual({
      showUnreadStyle: false,
      mentionBadgeCount: 0,
    });
  });

  it('FR-RS-05: 뮤트여도 멘션>0 이면 뱃지는 표시', () => {
    expect(deriveSidebarRowState({ unreadCount: 7, mentionCount: 4, muted: true })).toEqual({
      showUnreadStyle: false,
      mentionBadgeCount: 4,
    });
  });
});
