/**
 * S31 (FR-S02 combobox ARIA): 검색 입력 combobox 의 키보드 highlight 이동과
 * option/activedescendant id 생성을 담는 순수 로직. 컴포넌트는 이 함수를 써서
 * ArrowUp/Down 처리와 aria-activedescendant 동기화를 일관되게 합니다.
 */

export type NavDirection = 'up' | 'down';

/** clamp 이동(끝에서 멈춤, wrap 없음). count 0 이면 0. */
export function nextHighlightIndex(current: number, count: number, dir: NavDirection): number {
  if (count <= 0) return 0;
  if (dir === 'down') return Math.min(current + 1, count - 1);
  return Math.max(current - 1, 0);
}

/** option element id — listbox 항목의 안정적 식별자. */
export function optionId(group: string, index: number): string {
  return `qf-search-opt-${group}-${index}`;
}

/**
 * aria-activedescendant 값 — highlight 된 항목 id. 항목이 없으면 undefined
 * (속성 미설정).
 */
export function activeDescendantId(
  group: string,
  index: number,
  count: number,
): string | undefined {
  if (count <= 0) return undefined;
  return optionId(group, Math.min(Math.max(index, 0), count - 1));
}
