import { describe, it, expect } from 'vitest';
import { badgeVariant, badgeAriaLabel, badgeText } from './badge-variant';

/**
 * task-047 iter2 (K3): unread vs mention badge variant 검증.
 */

describe('badgeVariant (task-047 K3)', () => {
  it('count=0 → none', () => {
    expect(badgeVariant(0, false)).toBe('none');
    expect(badgeVariant(0, true)).toBe('none');
    expect(badgeVariant(-1, true)).toBe('none');
  });

  it('count > 0 + mention=false → unread', () => {
    expect(badgeVariant(1, false)).toBe('unread');
    expect(badgeVariant(99, false)).toBe('unread');
  });

  it('count > 0 + mention=true → mention (강조)', () => {
    expect(badgeVariant(1, true)).toBe('mention');
    expect(badgeVariant(50, true)).toBe('mention');
  });
});

describe('badgeAriaLabel', () => {
  it('count=0 → null (badge 미렌더)', () => {
    expect(badgeAriaLabel(0, false)).toBeNull();
    expect(badgeAriaLabel(0, true)).toBeNull();
  });

  it('mention 우선 — "읽지 않은 멘션 N개"', () => {
    expect(badgeAriaLabel(3, true)).toBe('읽지 않은 멘션 3개');
  });

  it('일반 unread — "읽지 않음 N개"', () => {
    expect(badgeAriaLabel(5, false)).toBe('읽지 않음 5개');
  });
});

describe('badgeText', () => {
  it('count <= 0 → 빈 문자열', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
  });

  it('count 99 까지는 그대로', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
  });

  it('count > 99 는 99+', () => {
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(9999)).toBe('99+');
  });
});
