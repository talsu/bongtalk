import {
  useMutation,
  useQueryClient,
  useInfiniteQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import type { ListThreadRepliesResponse, MessageDto } from '@qufox/shared-types';
import { listThreadReplies } from './api';
import { sendMessage } from '../messages/api';
import { qk } from '../../lib/query-keys';

/**
 * Task-014-B: side-panel thread reader. Cursor-paginates via
 * nextCursor; the first page also carries the root message so the
 * panel header renders without a second request. Cache is keyed by
 * `['messages','thread', rootId]` so the realtime dispatcher can
 * append to the active thread without knowing the cursor.
 */
export function useThreadReplies(rootId: string | null) {
  return useInfiniteQuery({
    queryKey: qk.messages.thread(rootId ?? ''),
    queryFn: ({ pageParam }) =>
      listThreadReplies(rootId!, {
        cursor: (pageParam as string | undefined) ?? undefined,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListThreadRepliesResponse) =>
      last.pageInfo.hasMore ? (last.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: !!rootId,
  });
}

/**
 * Task-014-B: reply send. Reuses the regular send endpoint with the
 * parentMessageId hint. Optimistic insert lands on the thread cache
 * directly; the WS echo collapses the tempId via the dispatcher's
 * message.created branch (same as the main channel list).
 */
export function useSendReply(wsId: string, channelId: string, rootId: string) {
  const qc = useQueryClient();
  const threadKey = qk.messages.thread(rootId);

  return useMutation({
    mutationFn: async (args: { content: string; tempId: string; idempotencyKey: string }) =>
      sendMessage(
        wsId,
        channelId,
        { content: args.content, parentMessageId: rootId },
        args.idempotencyKey,
      ),
    onMutate: async ({ content, tempId }) => {
      await qc.cancelQueries({ queryKey: threadKey });
      const prev = qc.getQueryData<InfiniteData<ListThreadRepliesResponse>>(threadKey);
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
        parentMessageId: rootId,
        thread: null,
      };
      qc.setQueryData<InfiniteData<ListThreadRepliesResponse>>(threadKey, (old) => {
        if (!old) return old;
        const last = old.pages[old.pages.length - 1];
        return {
          ...old,
          pages: [...old.pages.slice(0, -1), { ...last, replies: [...last.replies, optimistic] }],
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(threadKey, ctx.prev);
    },
    onSuccess: (result, { tempId }) => {
      qc.setQueryData<InfiniteData<ListThreadRepliesResponse>>(threadKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            replies: p.replies.map((r) => (r.id === tempId ? result.message : r)),
          })),
        };
      });
    },
  });
}
