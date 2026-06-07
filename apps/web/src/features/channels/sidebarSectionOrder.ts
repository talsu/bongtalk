import { arrayMove } from '@dnd-kit/sortable';

/**
 * S85 (FR-CH-16): 사이드바 섹션/채널 드래그 재정렬의 anchor 계산.
 *
 * 즐겨찾기/채널 move 와 동일한 규약: arrayMove 로 새 순서를 만든 뒤 이동 항목의 앞
 * 항목을 afterId, 뒤 항목을 beforeId 로 보낸다(둘 다 없으면 말단 = 빈 객체). 서버
 * calcBetween 이 이 anchor 로 fractional position 을 계산한다.
 *
 * 반환 null = 노op(대상=anchor 또는 인덱스 미해석) — 호출부는 mutation 을 건너뛴다.
 */
export type MoveAnchor = { beforeId?: string; afterId?: string };

export function computeSectionChannelOrder(
  ids: string[],
  activeId: string,
  overId: string,
): MoveAnchor | null {
  if (activeId === overId) return null;
  const fromIdx = ids.indexOf(activeId);
  const toIdx = ids.indexOf(overId);
  if (fromIdx < 0 || toIdx < 0) return null;
  const newOrder = arrayMove(ids, fromIdx, toIdx);
  const newIndex = newOrder.indexOf(activeId);
  const before = newOrder[newIndex + 1];
  const after = newOrder[newIndex - 1];
  if (before) return { beforeId: before };
  if (after) return { afterId: after };
  return {};
}
