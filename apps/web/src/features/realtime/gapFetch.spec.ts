import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { GAP_FETCH_MAX_PAGES, PENDING_EVENTS_MAX } from '@qufox/shared-types';
import { runGapFetch, PendingEventBuffer, Backoff } from './gapFetch';

/**
 * S10 (FR-RT-07): gap-fetch 코어(재귀 페이징·dedup·머지·버퍼·백오프) 단위 테스트.
 */

function msg(id: string): MessageDto {
  return {
    id,
    channelId: '00000000-0000-4000-8000-000000000000',
    authorId: '00000000-0000-4000-8000-000000000001',
    content: id,
    contentRaw: id,
    contentAst: null,
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
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
  };
}

function page(
  items: MessageDto[],
  hasMore: boolean,
  prevCursor: string | null,
): ListMessagesResponse {
  return {
    items,
    pageInfo: { hasMore, nextCursor: null, prevCursor },
  };
}

describe('runGapFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('단일 페이지(hasMore=false)면 1페이지로 종료', async () => {
    const fetchPage = vi.fn(async () => page([msg('b'), msg('a')], false, 'cursor-b'));
    const res = await runGapFetch(fetchPage, 'cursor-start', (p) => p.pageInfo.prevCursor);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(res.pages).toBe(1);
    expect(res.truncated).toBe(false);
    // id 오름차순 dedup 머지.
    expect(res.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(res.oldestFetchedId).toBe('a');
  });

  it('hasMore 면 재귀 페이징하며 다음 after 커서를 사용', async () => {
    const fetchPage = vi
      .fn<(after: string) => Promise<ListMessagesResponse>>()
      .mockResolvedValueOnce(page([msg('c'), msg('b')], true, 'cursor-c'))
      .mockResolvedValueOnce(page([msg('e'), msg('d')], false, 'cursor-e'));
    const res = await runGapFetch(fetchPage, 'cursor-a', (p) => p.pageInfo.prevCursor);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 'cursor-a');
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'cursor-c');
    expect(res.pages).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.messages.map((m) => m.id)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('id 중복은 dedup(Set)으로 제거', async () => {
    const fetchPage = vi
      .fn<(after: string) => Promise<ListMessagesResponse>>()
      .mockResolvedValueOnce(page([msg('b'), msg('a')], true, 'cursor-b'))
      .mockResolvedValueOnce(page([msg('c'), msg('b')], false, 'cursor-c'));
    const res = await runGapFetch(fetchPage, 'cursor-0', (p) => p.pageInfo.prevCursor);
    expect(res.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('GAP_FETCH_MAX_PAGES 초과 시 truncated=true 로 중단', async () => {
    // 항상 hasMore=true, 매번 새로운 커서 → 무한 페이징을 상한이 막아야 함.
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return page([msg(`m${String(n).padStart(3, '0')}`)], true, `cursor-${n}`);
    });
    const res = await runGapFetch(fetchPage, 'cursor-init', (p) => p.pageInfo.prevCursor);
    expect(fetchPage).toHaveBeenCalledTimes(GAP_FETCH_MAX_PAGES);
    expect(res.pages).toBe(GAP_FETCH_MAX_PAGES);
    expect(res.truncated).toBe(true);
  });

  it('커서가 진전하지 않으면(동일 after 반복) 무한 루프 없이 중단', async () => {
    const fetchPage = vi.fn(async () => page([msg('a')], true, 'cursor-same'));
    const res = await runGapFetch(fetchPage, 'cursor-same', (p) => p.pageInfo.prevCursor);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(res.truncated).toBe(false);
  });

  it('빈 결과면 oldestFetchedId=null', async () => {
    const fetchPage = vi.fn(async () => page([], false, null));
    const res = await runGapFetch(fetchPage, 'cursor', (p) => p.pageInfo.prevCursor);
    expect(res.messages).toEqual([]);
    expect(res.oldestFetchedId).toBeNull();
  });
});

describe('PendingEventBuffer', () => {
  it('적재 순서를 보존하며 drain', () => {
    const buf = new PendingEventBuffer();
    expect(buf.push('message.created', { id: '1' })).toBe(true);
    expect(buf.push('message.updated', { id: '2' })).toBe(true);
    expect(buf.size).toBe(2);
    expect(buf.didOverflow).toBe(false);
    const drained = buf.drain();
    expect(drained.map((e) => e.event)).toEqual(['message.created', 'message.updated']);
    expect(buf.size).toBe(0);
  });

  it('PENDING_EVENTS_MAX 초과 시 드롭 + overflow 플래그', () => {
    const buf = new PendingEventBuffer();
    for (let i = 0; i < PENDING_EVENTS_MAX; i++) {
      expect(buf.push('message.created', { i })).toBe(true);
    }
    // 201번째는 드롭.
    expect(buf.push('message.created', { i: PENDING_EVENTS_MAX })).toBe(false);
    expect(buf.didOverflow).toBe(true);
    expect(buf.size).toBe(PENDING_EVENTS_MAX);
  });

  it('drain 후 overflow 플래그 리셋', () => {
    const buf = new PendingEventBuffer();
    for (let i = 0; i <= PENDING_EVENTS_MAX; i++) buf.push('x', { i });
    expect(buf.didOverflow).toBe(true);
    buf.drain();
    expect(buf.didOverflow).toBe(false);
  });
});

describe('Backoff', () => {
  it('지수 증가하며 cap 에서 포화', () => {
    const b = new Backoff(500, 2, 8000, 3);
    expect(b.nextDelay()).toBe(500); // 500*2^0
    expect(b.nextDelay()).toBe(1000); // 500*2^1
    expect(b.nextDelay()).toBe(2000); // 500*2^2
  });

  it('cap 을 넘지 않음', () => {
    const b = new Backoff(500, 2, 1500, 10);
    expect(b.nextDelay()).toBe(500);
    expect(b.nextDelay()).toBe(1000);
    expect(b.nextDelay()).toBe(1500); // 2000 → cap 1500
    expect(b.nextDelay()).toBe(1500);
  });

  it('maxAttempts(기본 3) 도달 시 exhausted', () => {
    const b = new Backoff(500, 2, 8000, 3);
    expect(b.exhausted).toBe(false);
    b.nextDelay();
    b.nextDelay();
    expect(b.exhausted).toBe(false);
    b.nextDelay();
    expect(b.exhausted).toBe(true);
    expect(b.attempts).toBe(3);
  });

  it('reset 후 재시작', () => {
    const b = new Backoff(500, 2, 8000, 3);
    b.nextDelay();
    b.nextDelay();
    b.nextDelay();
    expect(b.exhausted).toBe(true);
    b.reset();
    expect(b.exhausted).toBe(false);
    expect(b.nextDelay()).toBe(500);
  });
});
