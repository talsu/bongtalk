/**
 * S18 (FR-RC06) — 자동완성 listbox 키보드 네비게이션 (순수 함수).
 *
 * WAI-ARIA Combobox 의 aria-activedescendant 패턴: 포커스는 input 에 유지한
 * 채 active 인덱스만 ↑↓ 로 이동시키고 wrap 합니다. 항목이 없으면 -1.
 */
export type NavDirection = 'up' | 'down';

export function nextActiveIndex(current: number, direction: NavDirection, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 'down' ? 0 : count - 1;
  if (direction === 'down') return (current + 1) % count;
  return (current - 1 + count) % count;
}
