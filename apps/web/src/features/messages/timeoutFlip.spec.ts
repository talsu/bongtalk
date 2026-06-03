import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { applyTimeoutFailure } from './timeoutFlip';
import { optimisticIdFor, type OptimisticMessage } from './sendState';

/**
 * S09 (FR-RT-05): 타임아웃 발화 → 낙관 행 'failed' flip 의 이중-flip 방지
 * 규칙 단위 테스트.
 */

function makeCache(rows: OptimisticMessage[]): InfiniteData<ListMessagesResponse> {
  return {
    pages: [
      {
        items: rows as MessageDto[],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      } as ListMessagesResponse,
    ],
    pageParams: [undefined],
  };
}

function pendingRow(id: string): OptimisticMessage {
  return {
    id,
    channelId: 'ch-1',
    authorId: 'u-1',
    content: 'hi',
    contentRaw: 'hi',
    contentAst: null,
    contentPlain: 'hi',
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
    threadLocked: false,
    embeds: [],
    sendState: 'pending',
  };
}

describe('applyTimeoutFailure (FR-RT-05 double-flip guard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('여전히 pending 인 낙관 행을 failed 로 flip', () => {
    const id = optimisticIdFor('nonce-1');
    const cache = makeCache([pendingRow(id)]);
    const next = applyTimeoutFailure(cache, id);
    const row = next?.pages[0].items[0] as OptimisticMessage;
    expect(row.sendState).toBe('failed');
  });

  it('confirmed(행이 실서버 id 로 교체되어 사라짐)면 no-op (동일 참조 반환)', () => {
    const id = optimisticIdFor('nonce-1');
    // 낙관 행이 confirmed 되어 사라진 상태 — 다른 실서버 행만 존재.
    const cache = makeCache([{ ...pendingRow('real-id'), sendState: undefined }]);
    const next = applyTimeoutFailure(cache, id);
    expect(next).toBe(cache);
  });

  it('이미 failed 면 no-op (동일 참조 반환)', () => {
    const id = optimisticIdFor('nonce-1');
    const failed: OptimisticMessage = { ...pendingRow(id), sendState: 'failed' };
    const cache = makeCache([failed]);
    const next = applyTimeoutFailure(cache, id);
    expect(next).toBe(cache);
  });

  it('빈 캐시는 그대로 반환', () => {
    expect(applyTimeoutFailure(undefined, 'tmp-x')).toBeUndefined();
  });
});
