import type { MessageDto } from '@qufox/shared-types';
import { OPTIMISTIC_PREFIX } from './sendState';

/**
 * S83b 리뷰 fix-forward (a11y BLOCKER #1): 메시지 목록 roving tabindex 의 순수 로직.
 *
 * 활성화 메커니즘을 키보드 포커스 전용(roving tabindex)으로 단일화한다. MessageList
 * 가 `focusedMsgId` 를 소유하고, 각 row 는 `tabIndex={focusedMsgId===id ? 0 : -1}` 로
 * 렌더해 목록 전체가 Tab 한 스톱만 차지한다. ↑/↓ 로 focusedMsgId 를 이동하면 대상
 * row 에 DOM 포커스 + scrollIntoView 한다(가상화는 호출부가 scrollToIndex 후 포커스).
 *
 * 이 헬퍼는 "현재 focusedMsgId + 키 → 다음 focusedMsgId" 만 결정해 단위 검증으로
 * 고정한다(DOM 부수효과는 호출부). 시스템 메시지/낙관(tmp) 행도 포커스 가능한
 * row 로 렌더되므로 navigable 목록에 포함한다(전체 messageIds 순서를 그대로 쓴다).
 */

/** roving 으로 이동을 트리거하는 키. 그 외 키는 null(무동작 → 단일키 핸들러로). */
export type RovingKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isRovingKey(key: string): key is RovingKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
}

/**
 * 첫 Tab 진입 시 포커스를 받을 기본 메시지 id. 최신(마지막) 메시지(없으면 null).
 * 목록이 비어 있으면 null.
 */
export function initialFocusId(messageIds: readonly string[]): string | null {
  if (messageIds.length === 0) return null;
  return messageIds[messageIds.length - 1] ?? null;
}

/**
 * roving 이동 결과. nextId 가 null 이면 이동 없음(경계 도달 또는 빈 목록).
 */
export interface RovingResult {
  nextId: string | null;
  nextIndex: number;
}

/**
 * 현재 focusedMsgId + 방향키 → 다음 focusedMsgId.
 *
 * - currentId 가 목록에 없으면(스크롤로 윈도우가 바뀌어 stale) 방향에 맞는 끝(↑=마지막,
 *   ↓=첫째)에서 시작한다.
 * - ↑ 는 더 위(과거, index-1), ↓ 는 더 아래(미래, index+1). 경계를 넘지 않는다
 *   (clamp — wrap 하지 않음).
 * - Home=첫째(가장 과거), End=마지막(최신).
 */
export function nextRovingFocus(
  messageIds: readonly string[],
  currentId: string | null,
  key: RovingKey,
): RovingResult {
  if (messageIds.length === 0) return { nextId: null, nextIndex: -1 };
  const lastIndex = messageIds.length - 1;
  const cur = currentId === null ? -1 : messageIds.indexOf(currentId);

  let nextIndex: number;
  switch (key) {
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = lastIndex;
      break;
    case 'ArrowUp':
      // stale(미발견) 상태면 마지막에서 시작, 아니면 한 칸 위(clamp 0).
      nextIndex = cur < 0 ? lastIndex : Math.max(0, cur - 1);
      break;
    case 'ArrowDown':
      // stale 면 첫째에서 시작, 아니면 한 칸 아래(clamp lastIndex).
      nextIndex = cur < 0 ? 0 : Math.min(lastIndex, cur + 1);
      break;
  }
  return { nextId: messageIds[nextIndex] ?? null, nextIndex };
}

/**
 * S83b 리뷰 fix-forward (reviewer MED-1): M(리마인더) 단일키로 저장한 항목이 이미
 * 리마인더를 갖고 있는지 도출한다. 저장 토글 응답(SaveToggleResponse)에는 리마인더
 * 메타가 없으므로, 캐시된 저장 목록(어느 status 든)에서 savedMessageId 로 항목을 찾아
 * SavedItem 과 동일 규칙(reminderAt!=null AND reminderFiredAt==null)으로 판정한다.
 * 캐시에 없으면(목록 미로드) false 로 폴백한다(하드코딩 false 제거 — 캐시 hit 시 정확).
 */
export function deriveHasReminder(
  item: { reminderAt?: string | null; reminderFiredAt?: string | null } | undefined,
): boolean {
  if (!item) return false;
  const reminderAt = item.reminderAt ?? null;
  const reminderFiredAt = item.reminderFiredAt ?? null;
  return reminderAt !== null && reminderFiredAt === null;
}

/** 낙관(tmp) 행인지(서버 id 부재) — 저장/리마인더/일부 단일키 불가. */
export function isOptimisticRow(msg: Pick<MessageDto, 'id'>): boolean {
  return msg.id.startsWith(OPTIMISTIC_PREFIX);
}
