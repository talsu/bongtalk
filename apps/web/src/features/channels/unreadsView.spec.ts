import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paginateUnreads, sortUnreadsView } from './unreadsView';
import type { UnreadChannelSummary } from './useUnread';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function ch(over: Partial<UnreadChannelSummary> & { channelId: string }): UnreadChannelSummary {
  return {
    channelId: over.channelId,
    unreadCount: over.unreadCount ?? 1,
    hasMention: over.hasMention ?? false,
    mentionCount: over.mentionCount ?? 0,
    lastMessageAt: over.lastMessageAt ?? null,
  };
}

describe('sortUnreadsView (FR-RS-10)', () => {
  it('drops channels with no unread', () => {
    const rows = sortUnreadsView([
      ch({ channelId: 'a', unreadCount: 0 }),
      ch({ channelId: 'b', unreadCount: 3 }),
    ]);
    expect(rows.map((r) => r.channelId)).toEqual(['b']);
  });

  it('puts mention channels before non-mention channels', () => {
    const rows = sortUnreadsView([
      ch({ channelId: 'plain', unreadCount: 5, lastMessageAt: '2025-01-01T10:00:00Z' }),
      ch({
        channelId: 'mention',
        unreadCount: 1,
        mentionCount: 2,
        lastMessageAt: '2025-01-01T09:00:00Z',
      }),
    ]);
    expect(rows.map((r) => r.channelId)).toEqual(['mention', 'plain']);
  });

  it('orders by latest activity within the same mention tier', () => {
    const rows = sortUnreadsView([
      ch({ channelId: 'older', lastMessageAt: '2025-01-01T08:00:00Z' }),
      ch({ channelId: 'newer', lastMessageAt: '2025-01-01T12:00:00Z' }),
      ch({ channelId: 'mid', lastMessageAt: '2025-01-01T10:00:00Z' }),
    ]);
    expect(rows.map((r) => r.channelId)).toEqual(['newer', 'mid', 'older']);
  });

  it('places null lastMessageAt last and stays deterministic by id', () => {
    const rows = sortUnreadsView([
      ch({ channelId: 'znull', lastMessageAt: null }),
      ch({ channelId: 'anull', lastMessageAt: null }),
      ch({ channelId: 'has', lastMessageAt: '2025-01-01T01:00:00Z' }),
    ]);
    expect(rows.map((r) => r.channelId)).toEqual(['has', 'anull', 'znull']);
  });

  it('derives hasMention from mentionCount even if the flag is stale', () => {
    const [row] = sortUnreadsView([ch({ channelId: 'm', mentionCount: 3, hasMention: false })]);
    expect(row.hasMention).toBe(true);
  });
});

describe('paginateUnreads (FR-RS-10 cursor)', () => {
  const sorted = sortUnreadsView(
    Array.from({ length: 5 }, (_, i) =>
      ch({ channelId: `c${i}`, lastMessageAt: `2025-01-01T1${i}:00:00Z` }),
    ),
  );

  it('returns the first page with a nextCursor when more remain', () => {
    const page = paginateUnreads(sorted, 0, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBe(2);
  });

  it('accumulates rows across pages and ends with null cursor', () => {
    const page = paginateUnreads(sorted, 2, 2);
    // 누적 렌더(0..4 → 4개), 마지막 1개 남음.
    expect(page.rows).toHaveLength(4);
    expect(page.nextCursor).toBe(4);
    const last = paginateUnreads(sorted, 4, 2);
    expect(last.rows).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
  });
});
