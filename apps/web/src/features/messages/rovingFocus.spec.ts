/**
 * S83b 리뷰 fix-forward (a11y BLOCKER #1): 메시지 목록 roving tabindex 순수 로직 검증.
 *
 * MessageList 가 focusedMsgId 를 단일 출처로 소유하고, ↑/↓/Home/End 로 다음 포커스
 * 행을 이동한다. 이 helper 는 "현재 focusedMsgId + 키 → 다음 id/index" 만 결정하므로
 * 경계 clamp·stale 복구·초기 포커스(최신)·hasReminder 도출을 단위로 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  initialFocusId,
  isRovingKey,
  nextRovingFocus,
  deriveHasReminder,
  isOptimisticRow,
} from './rovingFocus';

const IDS = ['m0', 'm1', 'm2', 'm3', 'm4'];

describe('isRovingKey', () => {
  it('recognizes Arrow/Home/End as roving keys', () => {
    expect(isRovingKey('ArrowUp')).toBe(true);
    expect(isRovingKey('ArrowDown')).toBe(true);
    expect(isRovingKey('Home')).toBe(true);
    expect(isRovingKey('End')).toBe(true);
  });
  it('rejects non-roving keys (single-key letters / Delete)', () => {
    expect(isRovingKey('e')).toBe(false);
    expect(isRovingKey('Delete')).toBe(false);
    expect(isRovingKey('Enter')).toBe(false);
  });
});

describe('initialFocusId — first Tab lands on the newest message', () => {
  it('returns the last (newest) message id', () => {
    expect(initialFocusId(IDS)).toBe('m4');
  });
  it('returns null for an empty list', () => {
    expect(initialFocusId([])).toBeNull();
  });
});

describe('nextRovingFocus — ArrowUp / ArrowDown move one step (clamped)', () => {
  it('ArrowUp moves to the older (previous) message', () => {
    expect(nextRovingFocus(IDS, 'm2', 'ArrowUp')).toEqual({ nextId: 'm1', nextIndex: 1 });
  });
  it('ArrowDown moves to the newer (next) message', () => {
    expect(nextRovingFocus(IDS, 'm2', 'ArrowDown')).toEqual({ nextId: 'm3', nextIndex: 3 });
  });
  it('ArrowUp clamps at the top (oldest) — no wrap', () => {
    expect(nextRovingFocus(IDS, 'm0', 'ArrowUp')).toEqual({ nextId: 'm0', nextIndex: 0 });
  });
  it('ArrowDown clamps at the bottom (newest) — no wrap', () => {
    expect(nextRovingFocus(IDS, 'm4', 'ArrowDown')).toEqual({ nextId: 'm4', nextIndex: 4 });
  });
});

describe('nextRovingFocus — Home / End jump to ends', () => {
  it('Home focuses the first (oldest) message', () => {
    expect(nextRovingFocus(IDS, 'm3', 'Home')).toEqual({ nextId: 'm0', nextIndex: 0 });
  });
  it('End focuses the last (newest) message', () => {
    expect(nextRovingFocus(IDS, 'm1', 'End')).toEqual({ nextId: 'm4', nextIndex: 4 });
  });
});

describe('nextRovingFocus — stale / null current id recovery', () => {
  it('null current + ArrowUp starts from the newest', () => {
    expect(nextRovingFocus(IDS, null, 'ArrowUp')).toEqual({ nextId: 'm4', nextIndex: 4 });
  });
  it('null current + ArrowDown starts from the oldest', () => {
    expect(nextRovingFocus(IDS, null, 'ArrowDown')).toEqual({ nextId: 'm0', nextIndex: 0 });
  });
  it('current id not in list (evicted) + ArrowUp starts from the newest', () => {
    expect(nextRovingFocus(IDS, 'gone', 'ArrowUp')).toEqual({ nextId: 'm4', nextIndex: 4 });
  });
  it('empty list → no move', () => {
    expect(nextRovingFocus([], 'm0', 'ArrowDown')).toEqual({ nextId: null, nextIndex: -1 });
  });
});

describe('deriveHasReminder — M(reminder) hasReminder derivation (reviewer MED-1)', () => {
  it('true when reminderAt set and not yet fired', () => {
    expect(deriveHasReminder({ reminderAt: '2025-01-02T00:00:00Z', reminderFiredAt: null })).toBe(
      true,
    );
  });
  it('false when no reminderAt', () => {
    expect(deriveHasReminder({ reminderAt: null, reminderFiredAt: null })).toBe(false);
  });
  it('false when already fired (no longer pending)', () => {
    expect(
      deriveHasReminder({
        reminderAt: '2025-01-02T00:00:00Z',
        reminderFiredAt: '2025-01-02T00:00:00Z',
      }),
    ).toBe(false);
  });
  it('false when the saved item is not cached (undefined)', () => {
    expect(deriveHasReminder(undefined)).toBe(false);
  });
});

describe('isOptimisticRow', () => {
  it('true for tmp- rows, false for server ids', () => {
    expect(isOptimisticRow({ id: 'tmp-abc' })).toBe(true);
    expect(isOptimisticRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001' })).toBe(false);
  });
});
