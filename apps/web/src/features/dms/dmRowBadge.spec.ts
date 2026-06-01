import { describe, it, expect } from 'vitest';
import { deriveDmBadgeCount, dmBadgeText } from './dmRowBadge';

describe('deriveDmBadgeCount (FR-DM-15)', () => {
  it('비뮤트 DM 은 unreadCount 그대로 표시', () => {
    expect(deriveDmBadgeCount({ unreadCount: 4, muted: false })).toBe(4);
  });

  it('비뮤트 + unread 0 → 0(배지 숨김)', () => {
    expect(deriveDmBadgeCount({ unreadCount: 0, muted: false })).toBe(0);
  });

  it('뮤트 DM 은 unread 를 억제(mention 입력 없으면 0)', () => {
    expect(deriveDmBadgeCount({ unreadCount: 9, muted: true })).toBe(0);
  });

  it('뮤트 DM 은 @멘션 건수만 표시', () => {
    expect(deriveDmBadgeCount({ unreadCount: 9, muted: true, mentionCount: 2 })).toBe(2);
  });

  it('뮤트 + mention 0 → 0', () => {
    expect(deriveDmBadgeCount({ unreadCount: 9, muted: true, mentionCount: 0 })).toBe(0);
  });
});

describe('dmBadgeText', () => {
  it('99 초과는 99+ 로 cap', () => {
    expect(dmBadgeText(120)).toBe('99+');
  });
  it('1~99 는 그대로', () => {
    expect(dmBadgeText(42)).toBe('42');
  });
  it('0 이하는 빈 문자열', () => {
    expect(dmBadgeText(0)).toBe('');
    expect(dmBadgeText(-1)).toBe('');
  });
});
