import { describe, it, expect } from 'vitest';
import { nextHighlightIndex, activeDescendantId, optionId } from './comboboxNav';

/**
 * S31 (FR-S02 combobox ARIA): 키보드 highlight 이동 + aria-activedescendant
 * id 동기화의 순수 로직. jsdom 없이 단위 테스트한다(환경 node).
 */
describe('nextHighlightIndex (S31 combobox)', () => {
  it('ArrowDown 은 다음으로, 끝에서 멈춤(clamp)', () => {
    expect(nextHighlightIndex(0, 3, 'down')).toBe(1);
    expect(nextHighlightIndex(2, 3, 'down')).toBe(2);
  });

  it('ArrowUp 은 이전으로, 0 에서 멈춤', () => {
    expect(nextHighlightIndex(2, 3, 'up')).toBe(1);
    expect(nextHighlightIndex(0, 3, 'up')).toBe(0);
  });

  it('항목이 0개면 항상 0', () => {
    expect(nextHighlightIndex(0, 0, 'down')).toBe(0);
    expect(nextHighlightIndex(0, 0, 'up')).toBe(0);
  });
});

describe('optionId / activeDescendantId (S31 combobox)', () => {
  it('optionId 는 prefix + index 조합', () => {
    expect(optionId('result', 0)).toBe('qf-search-opt-result-0');
    expect(optionId('suggest', 2)).toBe('qf-search-opt-suggest-2');
  });

  it('activeDescendantId 는 항목이 있을 때만 id, 없으면 undefined', () => {
    expect(activeDescendantId('result', 1, 3)).toBe('qf-search-opt-result-1');
    expect(activeDescendantId('result', 0, 0)).toBeUndefined();
  });
});
