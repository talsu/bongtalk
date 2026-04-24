import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse } from '@qufox/shared-types';
import { addReaction, removeReaction } from './api';
import { qk } from '../../lib/query-keys';
import { upsertReactionBucket } from '../realtime/dispatcher';

/**
 * Task-013-B: toggle reaction mutation with optimistic cache update.
 * The WS `message.reaction.(added|removed)` event will reconcile the
 * count server-authoritatively when it arrives — the optimistic patch
 * exists only so the UI flips instantly on click. `onError` rolls back
 * by restoring the pre-mutation bucket.
 */
export function useToggleReaction(wsId: string | null, channelId: string) {
  const qc = useQueryClient();
  const key = qk.messages.list(wsId ?? 'global', channelId);

  return useMutation({
    mutationFn: async (args: { messageId: string; emoji: string; currentlyByMe: boolean }) => {
      if (args.currentlyByMe) {
        await removeReaction(args.messageId, args.emoji);
        return { kind: 'removed' as const, ...args };
      }
      await addReaction(args.messageId, args.emoji);
      return { kind: 'added' as const, ...args };
    },
    onMutate: async ({ messageId, emoji, currentlyByMe }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<InfiniteData<ListMessagesResponse>>(key);
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => {
              if (m.id !== messageId) return m;
              // Optimistic ±1. The WS echo will overwrite count with the
              // server total, so any skew resolves within one RTT.
              const bucket = (m.reactions ?? []).find((r) => r.emoji === emoji);
              const currentCount = bucket?.count ?? 0;
              const nextCount = currentlyByMe ? currentCount - 1 : currentCount + 1;
              const next = upsertReactionBucket(m.reactions ?? [], {
                emoji,
                count: nextCount,
                kind: currentlyByMe ? 'removed' : 'added',
                mineChanges: true,
              });
              return { ...m, reactions: next };
            }),
          })),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
  });
}
