import { describe, it, expect } from 'vitest';
import type { ThreadSummary } from '@qufox/shared-types';
import { canStartThread, threadChipVisible } from './threadActionGate';

// S33 (FR-TH-01): 루트 메시지에만 'Reply in thread' 액션을 노출하고, 답글
// (parentMessageId 보유)·낙관적(tmp-) 행에는 노출하지 않는다.
describe('canStartThread (FR-TH-01 reply-in-thread gate)', () => {
  const rootId = '11111111-1111-1111-1111-111111111111';
  const replyId = '22222222-2222-2222-2222-222222222222';

  it('allows a persisted root message when a handler is wired', () => {
    expect(canStartThread({ id: rootId, parentMessageId: null, deleted: false }, true)).toBe(true);
  });

  it('blocks a reply (parentMessageId set) — replies cannot host threads', () => {
    expect(canStartThread({ id: replyId, parentMessageId: rootId, deleted: false }, true)).toBe(
      false,
    );
  });

  it('blocks an optimistic (tmp-) row that has no server id yet', () => {
    expect(canStartThread({ id: 'tmp-abc', parentMessageId: null, deleted: false }, true)).toBe(
      false,
    );
  });

  it('blocks when no onOpenThread handler is provided (e.g. DM/no-thread context)', () => {
    expect(canStartThread({ id: rootId, parentMessageId: null, deleted: false }, false)).toBe(
      false,
    );
  });

  // S33 fix-forward (MAJOR-2): 삭제된 루트 placeholder 에서는 스레드를 새로
  // 시작할 수 없다 — GET /thread 가 deletedAt:null 루트만 200 → 404 방지.
  it('blocks a soft-deleted root (GET /thread 404 게이트)', () => {
    expect(canStartThread({ id: rootId, parentMessageId: null, deleted: true }, true)).toBe(false);
  });
});

// S33 fix-forward (MAJOR-2 + NIT-2): 'N개 답글 보기' chip 의 가시성 게이트.
// 삭제된 thread-root placeholder 에서는 chip 클릭 시 GET /thread 404 이므로
// chip 을 숨긴다.
describe('threadChipVisible (MAJOR-2 + NIT-2 thread chip gate)', () => {
  const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
    replyCount: 2,
    lastRepliedAt: '2025-01-01T00:00:00.000Z',
    recentReplyUserIds: [],
    hasUnread: false,
    ...over,
  });

  it('shows the chip on a live root with at least one reply', () => {
    expect(threadChipVisible({ deleted: false }, thread({ replyCount: 3 }), true)).toBe(true);
  });

  it('hides when no onOpenThread handler is wired', () => {
    expect(threadChipVisible({ deleted: false }, thread({ replyCount: 3 }), false)).toBe(false);
  });

  it('hides when there is no thread meta', () => {
    expect(threadChipVisible({ deleted: false }, null, true)).toBe(false);
  });

  it('hides when replyCount is 0', () => {
    expect(threadChipVisible({ deleted: false }, thread({ replyCount: 0 }), true)).toBe(false);
  });

  it('hides on a soft-deleted thread-root placeholder (404 게이트)', () => {
    expect(threadChipVisible({ deleted: true }, thread({ replyCount: 1 }), true)).toBe(false);
  });
});
