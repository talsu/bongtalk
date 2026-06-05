/**
 * S83b round-2 (reviewer MAJOR M1 · a11y BLOCKER #1): MessageList roving 통합 갭 보완.
 *
 * MessageList 의 roving 포커스 좌표계는 세 순수 조각의 합성이다:
 *   1. computeNavigableIds(messages)  — 포커스 타깃이 있는 행만(삭제/시스템 제외)
 *   2. effectiveFocusedId             — focusedMsgId 가 navigable 에 없으면 initialFocusId 폴백
 *   3. handleRovingMove               — nextRovingFocus(navigableIds, effectiveFocusedId, key)
 *
 * 가상화(useVirtualizer)는 jsdom 에 레이아웃이 없어 0 행을 렌더하므로, MessageList 를
 * 그대로 마운트해 DOM tabIndex 를 검증하는 것은 신뢰성이 낮다(마운트 과중 — 부모
 * 브리프의 escape hatch). 대신 MessageList 가 쓰는 것과 *동일한* 순수 조각의 합성을
 * 여기서 검증해 회귀를 고정한다:
 *   (a) 삭제된 최신 메시지여도 tabIndex=0 행(effectiveFocusedId)은 가장 가까운 비-삭제
 *       메시지로 떨어진다(포커스 진입이 깨지지 않는다).
 *   (b) roving ↓/↑ 는 삭제 행을 스킵한다(navigable 좌표계가 삭제 행을 제외하므로).
 *   (c) 채널 전환 시 focusedMsgId 가 null 로 리셋되면 effectiveFocusedId 는 새 채널의
 *       최신 navigable 메시지로 떨어진다.
 *
 * DOM 레벨(실제 article tabIndex)은 MessageItem.singleKey.spec 의 focused prop 계약
 * (focused=false→-1, focused 미전달/true→0, onRovingMove 배선)으로 별도 커버된다.
 */
import { describe, it, expect } from 'vitest';
import type { MessageDto } from '@qufox/shared-types';
import { computeNavigableIds, initialFocusId, nextRovingFocus } from './rovingFocus';

type Row = Pick<MessageDto, 'id' | 'type' | 'deleted'>;

function row(id: string, over: Partial<Row> = {}): Row {
  return { id, type: 'DEFAULT', deleted: false, ...over };
}

/** MessageList 의 effectiveFocusedId 와 동일한 합성(focusedMsgId 가 navigable 에 없으면 폴백). */
function effectiveFocusedId(navigableIds: string[], focusedMsgId: string | null): string | null {
  if (focusedMsgId !== null && navigableIds.includes(focusedMsgId)) return focusedMsgId;
  return initialFocusId(navigableIds);
}

describe('computeNavigableIds — focus targets only (deleted/system excluded)', () => {
  it('keeps DEFAULT messages, drops deleted + system rows', () => {
    const msgs: Row[] = [
      row('m0'),
      row('m1', { deleted: true }),
      row('m2', { type: 'SYSTEM_PIN' }),
      row('m3'),
    ];
    expect(computeNavigableIds(msgs)).toEqual(['m0', 'm3']);
  });

  it('returns empty when every row is deleted or system', () => {
    const msgs: Row[] = [row('m0', { deleted: true }), row('m1', { type: 'SYSTEM_PIN' })];
    expect(computeNavigableIds(msgs)).toEqual([]);
  });
});

describe('(a) deleted newest message still yields a tabIndex=0 row', () => {
  it('effectiveFocusedId falls back to the newest NON-deleted message', () => {
    // 최신(마지막) 메시지가 삭제됨 → roving 진입 시 그 직전 비-삭제 메시지가 Tab 스톱.
    const msgs: Row[] = [row('m0'), row('m1'), row('m2', { deleted: true })];
    const navigableIds = computeNavigableIds(msgs);
    expect(navigableIds).toEqual(['m0', 'm1']);
    // focusedMsgId 미설정(첫 Tab) → 최신 navigable(m1).
    expect(effectiveFocusedId(navigableIds, null)).toBe('m1');
  });

  it('effectiveFocusedId recovers when the focused row was just deleted', () => {
    // 사용자가 m2 에 포커스 중이었는데 m2 가 삭제됨 → navigable 에서 빠지므로 폴백.
    const msgs: Row[] = [row('m0'), row('m1'), row('m2', { deleted: true })];
    const navigableIds = computeNavigableIds(msgs);
    expect(effectiveFocusedId(navigableIds, 'm2')).toBe('m1');
  });
});

describe('(b) roving ↓/↑ skips deleted rows', () => {
  it('ArrowDown over navigable ids steps past a deleted middle row', () => {
    // m1 이 삭제됨 → navigable = [m0, m2]. m0 에서 ↓ 는 m1(삭제) 을 건너뛰어 m2.
    const msgs: Row[] = [row('m0'), row('m1', { deleted: true }), row('m2')];
    const navigableIds = computeNavigableIds(msgs);
    expect(navigableIds).toEqual(['m0', 'm2']);
    expect(nextRovingFocus(navigableIds, 'm0', 'ArrowDown')).toEqual({
      nextId: 'm2',
      nextIndex: 1,
    });
  });

  it('ArrowUp over navigable ids steps past a deleted middle row', () => {
    const msgs: Row[] = [row('m0'), row('m1', { deleted: true }), row('m2')];
    const navigableIds = computeNavigableIds(msgs);
    expect(nextRovingFocus(navigableIds, 'm2', 'ArrowUp')).toEqual({ nextId: 'm0', nextIndex: 0 });
  });
});

describe('(c) channel switch resets focusedMsgId → newest navigable of the new channel', () => {
  it('after reset (focusedMsgId=null) the new channel lands on its newest navigable', () => {
    // 채널 전환 시 MessageList 가 setFocusedMsgId(null) → 새 채널 메시지로 effective 재계산.
    const newChannel: Row[] = [row('n0'), row('n1'), row('n2')];
    const navigableIds = computeNavigableIds(newChannel);
    expect(effectiveFocusedId(navigableIds, null)).toBe('n2');
  });

  it('an empty new channel yields no focus target', () => {
    expect(effectiveFocusedId(computeNavigableIds([]), null)).toBeNull();
  });
});
