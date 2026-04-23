import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listCustomEmojis, deleteCustomEmoji, uploadCustomEmoji, type CustomEmoji } from './api';

/**
 * task-037-D: workspace custom emoji cache. 10-minute staleTime matches
 * the presigned GET URL TTL (30 min) with enough headroom for the
 * browser to keep an image rendered even after the query becomes stale,
 * but short enough that a newly-uploaded emoji becomes pickable without
 * a manual refresh.
 */
const STALE_10M = 10 * 60 * 1000;

export function useCustomEmojis(workspaceId: string | undefined | null) {
  return useQuery<{ items: CustomEmoji[] }>({
    queryKey: ['custom-emojis', workspaceId ?? ''],
    queryFn: () => listCustomEmojis(workspaceId as string),
    enabled: Boolean(workspaceId),
    staleTime: STALE_10M,
  });
}

export function useUploadCustomEmoji(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) =>
      uploadCustomEmoji(workspaceId, name, file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
    },
  });
}

export function useDeleteCustomEmoji(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emojiId: string) => deleteCustomEmoji(workspaceId, emojiId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
    },
  });
}
