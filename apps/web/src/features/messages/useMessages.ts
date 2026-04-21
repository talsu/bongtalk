import { useCallback, useEffect } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { deleteMessage, listMessages, sendMessage, updateMessage } from './api';
import { qk } from '../../lib/query-keys';

const keys = {
  // Route through the single qk registry so the realtime dispatcher and
  // this hook build the IDENTICAL tuple — reviewer flagged drift risk.
  list: (wsId: string, channelId: string) => qk.messages.list(wsId, channelId),
};

export function useMessageHistory(wsId: string, channelId: string) {
  return useInfiniteQuery({
    queryKey: keys.list(wsId, channelId),
    queryFn: ({ pageParam }) =>
      listMessages(wsId, channelId, {
        limit: 50,
        before: (pageParam as string | undefined) ?? undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListMessagesResponse) =>
      last.pageInfo.hasMore ? (last.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: !!wsId && !!channelId,
  });
}

export function useSendMessage(wsId: string, channelId: string) {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (args: { content: string; tempId: string; idempotencyKey: string }) =>
      sendMessage(wsId, channelId, { content: args.content }, args.idempotencyKey),
    onMutate: async ({ content, tempId }) => {
      await qc.cancelQueries({ queryKey: keys.list(wsId, channelId) });
      const prev = qc.getQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId));
      // Optimistic prepend with a tempId — server roundtrip replaces it.
      const optimistic: MessageDto = {
        id: tempId,
        channelId,
        authorId: 'optimistic',
        content,
        mentions: { users: [], channels: [], everyone: false },
        edited: false,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        reactions: [],
        parentMessageId: null,
        thread: null,
        attachments: [],
      };
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        return {
          ...old,
          pages: [{ ...first, items: [optimistic, ...first.items] }, ...rest],
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.list(wsId, channelId), ctx.prev);
    },
    onSuccess: (result, { tempId }) => {
      // Replace optimistic row (by tempId) with the server row.
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(keys.list(wsId, channelId), (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p, i) =>
            i === 0
              ? {
                  ...p,
                  items: p.items.map((m) => (m.id === tempId ? result.message : m)),
                }
              : p,
          ),
        };
      });
    },
  });

  const send = useCallback(
    (content: string) => {
      const tempId = `tmp-${crypto.randomUUID()}`;
      const idempotencyKey = crypto.randomUUID();
      mutation.mutate({ content, tempId, idempotencyKey });
    },
    [mutation],
  );

  return { send, mutation };
}

export function useUpdateMessage(wsId: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ msgId, content }: { msgId: string; content: string }) =>
      updateMessage(wsId, channelId, msgId, { content }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
  });
}

export function useDeleteMessage(wsId: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msgId: string) => deleteMessage(wsId, channelId, msgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list(wsId, channelId) }),
  });
}

/** Trigger fetchNextPage when the user scrolls near the top of a message list. */
export function useScrollFetch(
  rootRef: React.RefObject<HTMLElement>,
  onReachTop: () => void,
): void {
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 100) onReachTop();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [rootRef, onReachTop]);
}
