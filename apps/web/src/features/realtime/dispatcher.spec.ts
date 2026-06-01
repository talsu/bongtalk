import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { DISPATCHED_EVENTS, installRealtimeDispatcher, upsertReactionBucket } from './dispatcher';
import { qk } from '../../lib/query-keys';
import { useReadState } from './readStateStore';

function makeFakeSocket(): Socket & { emit: (event: string, payload: unknown) => void } {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const socket = {
    on: (event: string, h: (e: unknown) => void) => {
      (handlers[event] ??= []).push(h);
      return socket;
    },
    off: (event: string, h: (e: unknown) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((x) => x !== h);
      return socket;
    },
    emit: (event: string, payload: unknown) => {
      for (const h of handlers[event] ?? []) h(payload);
    },
  } as unknown as Socket & { emit: (event: string, payload: unknown) => void };
  return socket;
}

describe('realtime dispatcher', () => {
  it('installs listeners for every dispatched event type', () => {
    const socket = makeFakeSocket();
    const spy = vi.spyOn(socket, 'on');
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    const registered = new Set(spy.mock.calls.map((c) => c[0]));
    for (const ev of DISPATCHED_EVENTS) {
      expect(registered.has(ev), `missing listener for ${ev}`).toBe(true);
    }
    detach();
  });

  it('message.created prepends to the channel cache without refetch', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const key = qk.messages.list('ws-1', 'ch-1');
    qc.setQueryData(key, {
      pages: [{ items: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('message.created', {
      id: 'ev-1',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      message: {
        id: 'msg-a',
        channelId: 'ch-1',
        authorId: 'u-1',
        content: 'hi',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
      },
    });
    const state = qc.getQueryData(key) as {
      pages: Array<{ items: Array<{ id: string }> }>;
    };
    expect(state.pages[0].items[0].id).toBe('msg-a');
    detach();
  });

  it('message.created with nonce swaps the matching optimistic row (FR-MSG-04)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const key = qk.messages.list('ws-1', 'ch-1');
    const nonce = '11111111-1111-4111-8111-111111111111';
    // Optimistic pending row whose id encodes the clientNonce (tmp-<nonce>).
    qc.setQueryData(key, {
      pages: [
        {
          items: [
            {
              id: `tmp-${nonce}`,
              channelId: 'ch-1',
              authorId: 'optimistic',
              content: 'hi',
              mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
              edited: false,
              deleted: false,
              createdAt: new Date().toISOString(),
              editedAt: null,
              reactions: [],
              sendState: 'pending',
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('message.created', {
      id: 'ev-1',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      nonce, // server echoes the clientNonce
      message: {
        id: 'real-server-id',
        channelId: 'ch-1',
        authorId: 'u-1',
        content: 'hi',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
      },
    });
    const state = qc.getQueryData(key) as { pages: Array<{ items: Array<{ id: string }> }> };
    // Exactly one row, the optimistic tmp-<nonce> replaced by the server id.
    expect(state.pages[0].items.map((i) => i.id)).toEqual(['real-server-id']);
    detach();
  });

  it('message.created dedupes by messageId across tabs even when nonce is absent', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const key = qk.messages.list('ws-1', 'ch-1');
    // Other tab: the confirmed row already landed by id; a re-broadcast must
    // not duplicate it (FR-RT-24).
    qc.setQueryData(key, {
      pages: [
        {
          items: [
            {
              id: 'real-server-id',
              channelId: 'ch-1',
              authorId: 'u-1',
              content: 'hi',
              mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
              edited: false,
              deleted: false,
              createdAt: new Date().toISOString(),
              editedAt: null,
              reactions: [],
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('message.created', {
      id: 'ev-1',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      message: {
        id: 'real-server-id',
        channelId: 'ch-1',
        authorId: 'u-1',
        content: 'hi',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
      },
    });
    const state = qc.getQueryData(key) as { pages: Array<{ items: Array<{ id: string }> }> };
    expect(state.pages[0].items.map((i) => i.id)).toEqual(['real-server-id']);
    detach();
  });

  it('upsertReactionBucket: server count overwrites, byMe flips only for my event', () => {
    // Empty → add: creates a new bucket at count 1 / byMe=true when it's mine.
    expect(
      upsertReactionBucket([], { emoji: '👍', count: 1, kind: 'added', mineChanges: true }),
    ).toEqual([{ emoji: '👍', count: 1, byMe: true }]);

    // Someone else's add doesn't flip my byMe.
    expect(
      upsertReactionBucket([{ emoji: '👍', count: 1, byMe: true }], {
        emoji: '👍',
        count: 2,
        kind: 'added',
        mineChanges: false,
      }),
    ).toEqual([{ emoji: '👍', count: 2, byMe: true }]);

    // My removal → byMe=false and count follows server.
    expect(
      upsertReactionBucket([{ emoji: '👍', count: 2, byMe: true }], {
        emoji: '👍',
        count: 1,
        kind: 'removed',
        mineChanges: true,
      }),
    ).toEqual([{ emoji: '👍', count: 1, byMe: false }]);

    // count→0 drops the bucket entirely.
    expect(
      upsertReactionBucket([{ emoji: '👍', count: 1, byMe: false }], {
        emoji: '👍',
        count: 0,
        kind: 'removed',
        mineChanges: false,
      }),
    ).toEqual([]);
  });

  it('message.reaction.added updates the target message bucket', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const key = qk.messages.list('ws-1', 'ch-1');
    qc.setQueryData(key, {
      pages: [
        {
          items: [
            {
              id: 'msg-a',
              channelId: 'ch-1',
              authorId: 'u-1',
              content: 'hi',
              mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
              edited: false,
              deleted: false,
              createdAt: new Date().toISOString(),
              editedAt: null,
              reactions: [],
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc, {
      viewerId: () => 'u-1',
      activeChannelId: () => 'ch-1',
    });
    socket.emit('message.reaction.added', {
      messageId: 'msg-a',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      emoji: '🎉',
      count: 1,
    });
    const state = qc.getQueryData(key) as {
      pages: Array<{
        items: Array<{
          id: string;
          reactions: Array<{ emoji: string; count: number; byMe: boolean }>;
        }>;
      }>;
    };
    expect(state.pages[0].items[0].reactions).toEqual([{ emoji: '🎉', count: 1, byMe: true }]);
    detach();
  });

  it('message.thread.replied patches the root summary in channel cache', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const key = qk.messages.list('ws-1', 'ch-1');
    qc.setQueryData(key, {
      pages: [
        {
          items: [
            {
              id: 'root-1',
              channelId: 'ch-1',
              authorId: 'author',
              content: 'hi',
              mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
              edited: false,
              deleted: false,
              createdAt: new Date().toISOString(),
              editedAt: null,
              reactions: [],
              parentMessageId: null,
              thread: null,
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc, {
      viewerId: () => 'viewer',
      activeChannelId: () => 'ch-1',
    });
    socket.emit('message.thread.replied', {
      id: 'ev-1',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      rootMessageId: 'root-1',
      replierId: 'author',
      replyCount: 3,
      lastRepliedAt: '2025-01-02T00:00:00Z',
      recentReplyUserIds: ['u-1', 'u-2'],
      recipients: ['author'],
    });
    const state = qc.getQueryData(key) as {
      pages: Array<{
        items: Array<{
          id: string;
          thread: { replyCount: number; recentReplyUserIds: string[] } | null;
        }>;
      }>;
    };
    const root = state.pages[0].items[0];
    expect(root.thread?.replyCount).toBe(3);
    expect(root.thread?.recentReplyUserIds).toEqual(['u-1', 'u-2']);
    detach();
  });

  it('message.created with parentMessageId routes into thread cache (not channel list)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const listKey = qk.messages.list('ws-1', 'ch-1');
    const threadKey = qk.messages.thread('root-1');
    qc.setQueryData(listKey, {
      pages: [
        {
          items: [
            {
              id: 'root-1',
              channelId: 'ch-1',
              authorId: 'a',
              content: 'hi',
              mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
              edited: false,
              deleted: false,
              createdAt: new Date().toISOString(),
              editedAt: null,
              reactions: [],
              parentMessageId: null,
              thread: { replyCount: 0, lastRepliedAt: null, recentReplyUserIds: [] },
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    qc.setQueryData(threadKey, {
      pages: [
        {
          root: {
            id: 'root-1',
            channelId: 'ch-1',
            authorId: 'a',
            content: 'hi',
            mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
            edited: false,
            deleted: false,
            createdAt: new Date().toISOString(),
            editedAt: null,
            reactions: [],
            parentMessageId: null,
            thread: null,
          },
          replies: [],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc, {
      viewerId: () => 'viewer',
      activeChannelId: () => 'ch-1',
    });
    socket.emit('message.created', {
      id: 'ev-1',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      message: {
        id: 'reply-1',
        channelId: 'ch-1',
        authorId: 'other',
        content: 'hello back',
        mentions: { users: [], channels: [], everyone: false, here: false, channel: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        reactions: [],
        parentMessageId: 'root-1',
        thread: null,
      },
    });
    const list = qc.getQueryData(listKey) as {
      pages: Array<{ items: Array<{ id: string }> }>;
    };
    expect(list.pages[0].items.map((i) => i.id)).toEqual(['root-1']); // no reply
    const thread = qc.getQueryData(threadKey) as {
      pages: Array<{ replies: Array<{ id: string }> }>;
    };
    expect(thread.pages[0].replies.map((r) => r.id)).toEqual(['reply-1']);
    detach();
  });

  it('detaches all listeners so reconnect starts clean', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    const offSpy = vi.spyOn(socket, 'off');
    detach();
    expect(offSpy).toHaveBeenCalledTimes(DISPATCHED_EVENTS.length);
  });

  // ── S05 (FR-MSG-06 / FR-MSG-09) edit/delete cache patches ──────────────
  function seedMsg(overrides: Record<string, unknown> = {}) {
    return {
      id: 'msg-x',
      channelId: 'ch-1',
      authorId: 'u-1',
      content: 'orig',
      contentRaw: 'orig',
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
      ...overrides,
    };
  }

  type CachePage = { items: ReturnType<typeof seedMsg>[]; pageInfo: unknown };
  function readItems(qc: QueryClient): ReturnType<typeof seedMsg>[] {
    const data = qc.getQueryData(qk.messages.list('ws-1', 'ch-1')) as
      | { pages: CachePage[] }
      | undefined;
    return data?.pages[0]?.items ?? [];
  }

  it('message.updated merges new content + version into the cached row (FR-MSG-06)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    qc.setQueryData(qk.messages.list('ws-1', 'ch-1'), {
      pages: [
        {
          items: [seedMsg({ reactions: [{ emoji: '👍', count: 1, byMe: true }] })],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('message.updated', {
      id: 'ev-u',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      message: { id: 'msg-x', content: 'edited!', edited: true, version: 1 },
    });
    const row = readItems(qc)[0];
    expect(row.content).toBe('edited!');
    expect(row.version).toBe(1);
    // 미동봉 필드(reactions)는 보존된다(merge, not replace).
    expect(row.reactions).toHaveLength(1);
    detach();
  });

  it('message.deleted on a single message removes it from the list (FR-MSG-09)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    qc.setQueryData(qk.messages.list('ws-1', 'ch-1'), {
      pages: [
        {
          items: [seedMsg({ id: 'msg-solo' })],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('message.deleted', {
      id: 'ev-d',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      message: { id: 'msg-solo' },
    });
    expect(readItems(qc).find((m) => m.id === 'msg-solo')).toBeUndefined();
    detach();
  });

  it('message.deleted on a thread root with replies keeps a placeholder (FR-MSG-09)', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    qc.setQueryData(qk.messages.list('ws-1', 'ch-1'), {
      pages: [
        {
          items: [
            seedMsg({
              id: 'msg-root',
              thread: { replyCount: 2, lastRepliedAt: null, recentReplyUserIds: [] },
            }),
          ],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
      pageParams: [undefined],
    });
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('message.deleted', {
      id: 'ev-d2',
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      message: { id: 'msg-root' },
    });
    const row = readItems(qc).find((m) => m.id === 'msg-root');
    expect(row).toBeDefined();
    expect(row?.deleted).toBe(true);
    expect(row?.content).toBeNull();
    detach();
  });

  // S23 (FR-RS-06): read_state:updated 가 readStateStore 의 lastRead 를 전진시켜
  // NEW MESSAGES 구분선의 lastRead 출처가 멀티세션에서 정합하게 한다.
  it('read_state:updated advances readStateStore lastRead (multi-session sync)', () => {
    useReadState.setState({ lastReadByChannel: {} });
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('read_state:updated', {
      channelId: 'ch-rs',
      workspaceId: 'ws-1',
      lastReadMessageId: 'm-99',
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(useReadState.getState().getLastRead('ch-rs')).toBe('m-99');
    detach();
  });

  // S23 MAJOR fix: null lastReadMessageId 로는 store 를 삭제하지 않는다 —
  // around-reload seam(readStateStore 의 around=lastRead 재로드)을 보존하기
  // 위해 기존 커서 값을 유지한다(後進·소실 방지). 전진은 non-null 일 때만.
  it('read_state:updated with null lastReadMessageId keeps the existing store entry', () => {
    useReadState.setState({ lastReadByChannel: { 'ch-rs': 'm-1' } });
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('read_state:updated', {
      channelId: 'ch-rs',
      workspaceId: 'ws-1',
      lastReadMessageId: null,
      unreadCount: 5,
      mentionCount: 0,
    });
    expect(useReadState.getState().getLastRead('ch-rs')).toBe('m-1');
    detach();
  });

  // S26 (FR-P16): per-user presence:update fan-out lands under the per-user
  // cache key so a DM peer's dot can update with no workspace snapshot.
  it('presence:update writes the per-user presence cache entry', () => {
    const socket = makeFakeSocket();
    const qc = new QueryClient();
    const detach = installRealtimeDispatcher(socket, qc);
    socket.emit('presence:update', {
      userId: 'u-peer',
      status: 'offline',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(qc.getQueryData(qk.presence.user('u-peer'))).toEqual({
      status: 'offline',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    detach();
  });
});
