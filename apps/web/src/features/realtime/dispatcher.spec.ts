import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { DISPATCHED_EVENTS, installRealtimeDispatcher, upsertReactionBucket } from './dispatcher';
import { qk } from '../../lib/query-keys';

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
        mentions: { users: [], channels: [], everyone: false },
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
              mentions: { users: [], channels: [], everyone: false },
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
              mentions: { users: [], channels: [], everyone: false },
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
              mentions: { users: [], channels: [], everyone: false },
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
            mentions: { users: [], channels: [], everyone: false },
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
        mentions: { users: [], channels: [], everyone: false },
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
});
