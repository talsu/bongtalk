import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import {
  OPTIMISTIC_PREFIX,
  confirmOptimistic,
  isOptimisticId,
  markOptimisticFailed,
  markOptimisticPending,
  nonceFromOptimisticId,
  optimisticIdFor,
  prependOptimistic,
  type OptimisticMessage,
} from './sendState';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const NONCE = '11111111-1111-4111-8111-111111111111';

function makeMsg(id: string, extra: Partial<MessageDto> = {}): MessageDto {
  return {
    id,
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'hi',
    contentRaw: 'hi',
    contentAst: null,
    contentPlain: 'hi',
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false, roles: [] },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
    reactions: [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
    embeds: [],
    ...extra,
  };
}

function makeCache(items: MessageDto[]): InfiniteData<ListMessagesResponse> {
  return {
    pageParams: [undefined],
    pages: [{ items, pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }],
  };
}

describe('sendState — single-identifier optimistic helpers (S03 / FR-MSG-04)', () => {
  it('optimisticIdFor → nonceFromOptimisticId round-trips the clientNonce', () => {
    const id = optimisticIdFor(NONCE);
    expect(id).toBe(`${OPTIMISTIC_PREFIX}${NONCE}`);
    expect(nonceFromOptimisticId(id)).toBe(NONCE);
    expect(isOptimisticId(id)).toBe(true);
  });

  it('nonceFromOptimisticId returns null for a real server id', () => {
    const realId = '99999999-9999-4999-8999-999999999999';
    expect(nonceFromOptimisticId(realId)).toBeNull();
    expect(isOptimisticId(realId)).toBe(false);
  });

  it('prependOptimistic adds the pending row to the head of page 0', () => {
    const cache = makeCache([makeMsg('a')]);
    const opt: OptimisticMessage = { ...makeMsg(optimisticIdFor(NONCE)), sendState: 'pending' };
    const next = prependOptimistic(cache, opt);
    expect(next?.pages[0].items[0].id).toBe(optimisticIdFor(NONCE));
    expect(next?.pages[0].items).toHaveLength(2);
  });
});

describe('confirmOptimistic — server echo swap (FR-MSG-04)', () => {
  it('replaces the optimistic row with the confirmed server row', () => {
    const optId = optimisticIdFor(NONCE);
    const cache = makeCache([makeMsg(optId), makeMsg('older')]);
    const confirmed = makeMsg('real-server-id', { content: 'hi' });
    const next = confirmOptimistic(cache, optId, confirmed);
    expect(next?.pages[0].items[0].id).toBe('real-server-id');
    // no leftover optimistic row
    expect(next?.pages[0].items.some((m) => m.id === optId)).toBe(false);
  });

  it('is idempotent: if the optimistic id is already gone (WS echo first), cache is unchanged', () => {
    const cache = makeCache([makeMsg('real-server-id')]);
    const confirmed = makeMsg('real-server-id');
    const next = confirmOptimistic(cache, optimisticIdFor(NONCE), confirmed);
    expect(next).toBe(cache); // same reference — no churn
  });
});

describe('markOptimisticFailed / markOptimisticPending (FR-MSG-05)', () => {
  it('marks the row failed (kept in the list, not rolled out) for the retry button', () => {
    const optId = optimisticIdFor(NONCE);
    const cache = makeCache([{ ...makeMsg(optId), sendState: 'pending' } as MessageDto]);
    const next = markOptimisticFailed(cache, optId) as
      | InfiniteData<ListMessagesResponse>
      | undefined;
    const row = next?.pages[0].items[0] as OptimisticMessage;
    expect(row.id).toBe(optId); // still present
    expect(row.sendState).toBe('failed');
  });

  it('retry flips the failed row back to pending with the SAME id (same nonce)', () => {
    const optId = optimisticIdFor(NONCE);
    const cache = makeCache([{ ...makeMsg(optId), sendState: 'failed' } as MessageDto]);
    const next = markOptimisticPending(cache, optId) as
      | InfiniteData<ListMessagesResponse>
      | undefined;
    const row = next?.pages[0].items[0] as OptimisticMessage;
    expect(row.id).toBe(optId);
    expect(nonceFromOptimisticId(row.id)).toBe(NONCE);
    expect(row.sendState).toBe('pending');
  });

  it('mark* on a missing id leaves the cache reference unchanged', () => {
    const cache = makeCache([makeMsg('real')]);
    expect(markOptimisticFailed(cache, optimisticIdFor(NONCE))).toBe(cache);
    expect(markOptimisticPending(cache, optimisticIdFor(NONCE))).toBe(cache);
  });
});
