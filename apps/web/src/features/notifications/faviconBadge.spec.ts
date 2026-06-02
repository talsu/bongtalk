import { describe, it, expect } from 'vitest';
import { badgeCountText, documentTitleText, faviconBadgeMode } from './faviconBadge';

/**
 * S47 (FR-MN-14): favicon 규칙 + title 배지 텍스트 단위 검증.
 *   - mentionCount>0 → 'count'(숫자 배지)
 *   - unreadCount>0(멘션 0) → 'dot'
 *   - 둘 다 0 → 'none'(기본 favicon 원복)
 */
describe('faviconBadgeMode (S47 · FR-MN-14)', () => {
  it('mentionCount>0 → count(숫자 배지)', () => {
    expect(faviconBadgeMode(3, 10)).toBe('count');
    expect(faviconBadgeMode(1, 0)).toBe('count');
  });

  it('mentionCount==0 && unreadCount>0 → dot', () => {
    expect(faviconBadgeMode(0, 5)).toBe('dot');
  });

  it('둘 다 0 → none(기본 favicon 원복)', () => {
    expect(faviconBadgeMode(0, 0)).toBe('none');
  });
});

describe('badgeCountText / documentTitleText (S47 · FR-MN-14)', () => {
  it('99+ cap', () => {
    expect(badgeCountText(0)).toBe('');
    expect(badgeCountText(7)).toBe('7');
    expect(badgeCountText(100)).toBe('99+');
  });

  it('title: total>0 → "(N) qufox", 0 → "qufox"', () => {
    expect(documentTitleText(0)).toBe('qufox');
    expect(documentTitleText(4)).toBe('(4) qufox');
    expect(documentTitleText(250)).toBe('(99+) qufox');
  });
});
