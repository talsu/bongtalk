import { useEffect } from 'react';
import { type InfiniteData, useQueryClient } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { getSocket } from '../../lib/socket';

/**
 * Merges server-sent realtime events into the React Query cache used by
 * `useMessageHistory`. Dedupe is id-based: if the message already exists
 * (common for our own posts whose tempId was swapped in `onSuccess`), we
 * skip the insert.
 */
export function useLiveMessages(wsId: string, channelId: string): void {
  const qc = useQueryClient();
  const key = ['messages', wsId, channelId] as const;

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onCreated = (env: {
      channelId?: string;
      message?: MessageDto & { createdAt: string };
    }): void => {
      if (env.channelId !== channelId || !env.message) return;
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        // dedupe by id; also reconcile tempId → real id if present
        const existing = first.items.find((m) => m.id === env.message!.id);
        if (existing) return old;
        return {
          ...old,
          pages: [{ ...first, items: [env.message as MessageDto, ...first.items] }, ...rest],
        };
      });
    };

    const onUpdated = (env: { channelId?: string; message?: MessageDto }): void => {
      if (env.channelId !== channelId || !env.message) return;
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => (m.id === env.message!.id ? env.message! : m)),
          })),
        };
      });
    };

    const onDeleted = (env: { channelId?: string; message?: { id: string } }): void => {
      if (env.channelId !== channelId || !env.message) return;
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) =>
              m.id === env.message!.id ? { ...m, deleted: true, content: null } : m,
            ),
          })),
        };
      });
    };

    socket.on('message.created', onCreated);
    socket.on('message.updated', onUpdated);
    socket.on('message.deleted', onDeleted);

    return () => {
      socket.off('message.created', onCreated);
      socket.off('message.updated', onUpdated);
      socket.off('message.deleted', onDeleted);
    };
  }, [qc, wsId, channelId, key]);
}
