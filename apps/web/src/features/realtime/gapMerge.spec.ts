import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { mergeGapMessages } from './gapMerge';

function msg(id: string, createdAt: string, parentMessageId: string | null = null): MessageDto {
  return {
    id,
    channelId: '00000000-0000-4000-8000-000000000000',
    authorId: '00000000-0000-4000-8000-000000000001',
    content: id,
    contentRaw: id,
    contentAst: null,
    contentPlain: id,
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
    edited: false,
    deleted: false,
    createdAt,
    editedAt: null,
    reactions: [],
    parentMessageId,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 0,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
  };
}

function cache(items: MessageDto[]): InfiniteData<ListMessagesResponse> {
  return {
    pageParams: [undefined],
    pages: [{ items, pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }],
  };
}

describe('mergeGapMessages (FR-RT-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('캐시 미존재(undefined)면 그대로 반환', () => {
    expect(mergeGapMessages(undefined, [msg('a', '2025-01-01T00:00:01Z')])).toBeUndefined();
  });

  it('신규 메시지를 첫 페이지에 추가하고 createdAt DESC 로 정렬', () => {
    const old = cache([msg('b', '2025-01-01T00:00:02Z')]);
    const fetched = [msg('a', '2025-01-01T00:00:01Z'), msg('c', '2025-01-01T00:00:03Z')];
    const out = mergeGapMessages(old, fetched)!;
    expect(out.pages[0].items.map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  it('messageId dedup — 이미 캐시에 있는 메시지는 추가하지 않고 기존 유지', () => {
    const existing = msg('b', '2025-01-01T00:00:02Z');
    existing.content = '편집된본문'; // 캐시 측 상태 보존 확인용.
    const old = cache([existing]);
    const fetched = [msg('b', '2025-01-01T00:00:02Z'), msg('a', '2025-01-01T00:00:01Z')];
    const out = mergeGapMessages(old, fetched)!;
    expect(out.pages[0].items.map((m) => m.id)).toEqual(['b', 'a']);
    // 기존 'b' 의 편집 본문이 gap-fetch 본문으로 덮어쓰이지 않음.
    expect(out.pages[0].items.find((m) => m.id === 'b')!.content).toBe('편집된본문');
  });

  it('reply(parentMessageId != null)는 root 목록에 넣지 않음', () => {
    const old = cache([msg('root', '2025-01-01T00:00:01Z')]);
    const fetched = [msg('reply1', '2025-01-01T00:00:02Z', 'root')];
    const out = mergeGapMessages(old, fetched)!;
    expect(out.pages[0].items.map((m) => m.id)).toEqual(['root']);
  });

  it('추가할 것이 없으면 동일 참조 반환(불필요 리렌더 방지)', () => {
    const old = cache([msg('a', '2025-01-01T00:00:01Z')]);
    const out = mergeGapMessages(old, [msg('a', '2025-01-01T00:00:01Z')]);
    expect(out).toBe(old);
  });

  it('createdAt 동률이면 id DESC tie-break', () => {
    const old = cache([msg('aaa', '2025-01-01T00:00:01Z')]);
    const fetched = [msg('zzz', '2025-01-01T00:00:01Z')];
    const out = mergeGapMessages(old, fetched)!;
    expect(out.pages[0].items.map((m) => m.id)).toEqual(['zzz', 'aaa']);
  });
});
