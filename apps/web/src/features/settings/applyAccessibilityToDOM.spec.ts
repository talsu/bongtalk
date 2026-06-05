// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccessibilityToDOM } from './applyAccessibilityToDOM';

/**
 * S77a (D14 / FR-PS-12): applyAccessibilityToDOM 의 순수 부수효과 단위 테스트.
 * documentElement 의 data-reduce-motion / data-high-contrast 속성 토글을 검증한다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  document.documentElement.removeAttribute('data-reduce-motion');
  document.documentElement.removeAttribute('data-high-contrast');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-reduce-motion');
  document.documentElement.removeAttribute('data-high-contrast');
});

describe('applyAccessibilityToDOM', () => {
  it('sets data-reduce-motion="true" when reduceMotion is on', () => {
    applyAccessibilityToDOM({ reduceMotion: true, highContrast: false });
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
    expect(document.documentElement.getAttribute('data-high-contrast')).toBe('false');
  });

  it('sets data-high-contrast="true" when highContrast is on', () => {
    applyAccessibilityToDOM({ reduceMotion: false, highContrast: true });
    expect(document.documentElement.getAttribute('data-high-contrast')).toBe('true');
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('false');
  });

  it('writes "false" explicitly (does not remove the attribute) when toggled off', () => {
    applyAccessibilityToDOM({ reduceMotion: true, highContrast: true });
    applyAccessibilityToDOM({ reduceMotion: false, highContrast: false });
    // 속성을 지우지 않고 "false" 로 덮어써 OS 미디어쿼리만 단독으로 남게 한다.
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('false');
    expect(document.documentElement.getAttribute('data-high-contrast')).toBe('false');
  });
});
