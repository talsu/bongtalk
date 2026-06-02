// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collapsedKey, isCategoryCollapsed, setCategoryCollapsed } from './categoryCollapse';

const WS = '11111111-1111-1111-1111-111111111111';
const CAT = '22222222-2222-2222-2222-222222222222';

describe('categoryCollapse (FR-CH-14)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('PRD 정본 키 형식 {workspaceId}:category:{categoryId}:collapsed', () => {
    expect(collapsedKey(WS, CAT)).toBe(`${WS}:category:${CAT}:collapsed`);
  });

  it('새 기기(키 없음)는 기본 펼침 = collapsed false', () => {
    expect(isCategoryCollapsed(WS, CAT)).toBe(false);
  });

  it('접힘 저장 후 복원 = collapsed true ("1" 영속)', () => {
    setCategoryCollapsed(WS, CAT, true);
    expect(window.localStorage.getItem(collapsedKey(WS, CAT))).toBe('1');
    expect(isCategoryCollapsed(WS, CAT)).toBe(true);
  });

  it('펼침 저장은 키를 제거(누적 방지) → collapsed false', () => {
    setCategoryCollapsed(WS, CAT, true);
    setCategoryCollapsed(WS, CAT, false);
    expect(window.localStorage.getItem(collapsedKey(WS, CAT))).toBeNull();
    expect(isCategoryCollapsed(WS, CAT)).toBe(false);
  });

  it('카테고리별로 독립 — 한 카테고리 접힘이 다른 카테고리에 영향 없음', () => {
    const other = '33333333-3333-3333-3333-333333333333';
    setCategoryCollapsed(WS, CAT, true);
    expect(isCategoryCollapsed(WS, CAT)).toBe(true);
    expect(isCategoryCollapsed(WS, other)).toBe(false);
  });
});
