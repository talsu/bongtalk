import { describe, it, expect } from 'vitest';
import {
  deriveServerButtonBadge,
  serverButtonBadgeText,
  serverButtonBadgeAria,
} from './serverButtonBadge';

describe('deriveServerButtonBadge (FR-RS-15)', () => {
  it('mention 합산>0 → mention variant + 멘션 숫자', () => {
    expect(deriveServerButtonBadge({ unreadCount: 10, mentionCount: 3 })).toEqual({
      variant: 'mention',
      count: 3,
    });
  });

  it('mention 0 + unread>0 → unread variant', () => {
    expect(deriveServerButtonBadge({ unreadCount: 5, mentionCount: 0 })).toEqual({
      variant: 'unread',
      count: 5,
    });
  });

  it('둘 다 0 → none', () => {
    expect(deriveServerButtonBadge({ unreadCount: 0, mentionCount: 0 })).toEqual({
      variant: 'none',
      count: 0,
    });
  });
});

describe('serverButtonBadgeText', () => {
  it('99 초과는 99+', () => {
    expect(serverButtonBadgeText(150)).toBe('99+');
  });
  it('정상 카운트', () => {
    expect(serverButtonBadgeText(7)).toBe('7');
  });
  it('0 이하는 빈 문자열', () => {
    expect(serverButtonBadgeText(0)).toBe('');
  });
});

describe('serverButtonBadgeAria', () => {
  it('mention 변형', () => {
    expect(serverButtonBadgeAria({ variant: 'mention', count: 2 })).toBe('읽지 않은 멘션 2개');
  });
  it('unread 변형', () => {
    expect(serverButtonBadgeAria({ variant: 'unread', count: 4 })).toBe('읽지 않음 4개');
  });
  it('none 은 null', () => {
    expect(serverButtonBadgeAria({ variant: 'none', count: 0 })).toBeNull();
  });
});
