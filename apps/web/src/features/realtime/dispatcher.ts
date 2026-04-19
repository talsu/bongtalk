import { type QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import type { Socket } from 'socket.io-client';
import { qk } from '../../lib/query-keys';

/**
 * Centralized realtime → cache mapping. Every server event flows through
 * here — no other file installs socket listeners for cache mutations. This
 * makes adding a new event type a one-file change and makes the test
 * surface tiny (mock socket → emit → assert cache).
 *
 * The dispatcher returns a detach function so the caller (useRealtimeConnection)
 * can unsubscribe on teardown.
 */
export function installRealtimeDispatcher(socket: Socket, qc: QueryClient): () => void {
  const handlers: Array<{ event: string; handler: (e: unknown) => void }> = [];

  const on = <T>(event: string, handler: (e: T) => void): void => {
    const typed = handler as (e: unknown) => void;
    socket.on(event, typed);
    handlers.push({ event, handler: typed });
  };

  // ---------- Messages ----------
  on<{ id: string; channelId: string; workspaceId: string; message: MessageDto }>(
    'message.created',
    (env) => {
      if (!env.channelId || !env.workspaceId || !env.message) return;
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(
        qk.messages.list(env.workspaceId, env.channelId),
        (old) => {
          if (!old) return old;
          const [first, ...rest] = old.pages;
          // Dedupe by real id AND by the optimistic "tempId" pattern — if
          // the WS broadcast arrives BEFORE our own HTTP POST response
          // (common under load), plain id-equality misses the temp row and
          // we'd end up with two rows for one logical message. Collapse
          // any optimistic row that matches author+content.
          if (first.items.some((m) => m.id === env.message.id)) return old;
          const collapsed = first.items.filter(
            (m) =>
              !(
                m.id.startsWith('tmp-') &&
                m.authorId === 'optimistic' &&
                m.content === env.message.content
              ),
          );
          return {
            ...old,
            pages: [{ ...first, items: [env.message, ...collapsed] }, ...rest],
          };
        },
      );
    },
  );

  on<{ channelId: string; workspaceId: string; message: MessageDto }>('message.updated', (env) => {
    if (!env.channelId || !env.workspaceId) return;
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => (m.id === env.message.id ? env.message : m)),
          })),
        };
      },
    );
  });

  on<{ channelId: string; workspaceId: string; message: { id: string } }>(
    'message.deleted',
    (env) => {
      if (!env.channelId || !env.workspaceId) return;
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(
        qk.messages.list(env.workspaceId, env.channelId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: p.items.map((m) =>
                m.id === env.message.id ? { ...m, deleted: true, content: null } : m,
              ),
            })),
          };
        },
      );
    },
  );

  // ---------- Channels ----------
  on<{ workspaceId: string }>('channel.created', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.updated', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.deleted', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.moved', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.archived', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.unarchived', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });

  // ---------- Members / Workspace ----------
  on<{ workspaceId: string }>('workspace.member.joined', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
  });
  on<{ workspaceId: string }>('workspace.member.left', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.list() });
    }
  });
  on<{ workspaceId: string }>('workspace.member.removed', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.list() });
    }
  });
  on<{ workspaceId: string }>('workspace.role.changed', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.detail(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
    }
  });

  // ---------- Presence ----------
  on<{ workspaceId: string; onlineUserIds: string[] }>('presence.updated', (env) => {
    if (env.workspaceId) {
      qc.setQueryData(qk.presence.workspace(env.workspaceId), env.onlineUserIds);
    }
  });

  return () => {
    for (const { event, handler } of handlers) socket.off(event, handler);
  };
}

/** Event types the dispatcher handles — exposed so tests can iterate them. */
export const DISPATCHED_EVENTS = [
  'message.created',
  'message.updated',
  'message.deleted',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'channel.moved',
  'channel.archived',
  'channel.unarchived',
  'workspace.member.joined',
  'workspace.member.left',
  'workspace.member.removed',
  'workspace.role.changed',
  'presence.updated',
] as const;
