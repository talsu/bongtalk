import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * Task-010-B frontend: unread count per channel in the current
 * workspace. Hook reads the list from the server once (dispatcher
 * mutates the cache for each incoming message) and offers a
 * `mark-read` mutation.
 */

export interface UnreadChannelSummary {
  channelId: string;
  unreadCount: number;
  hasMention: boolean;
  lastMessageAt: string | null;
}

interface UnreadSummaryResponse {
  channels: UnreadChannelSummary[];
}

export function useUnreadSummary(workspaceId: string | undefined) {
  return useQuery({
    queryKey: workspaceId ? qk.channels.unreadSummary(workspaceId) : ['unread-summary', 'idle'],
    queryFn: () => apiRequest<UnreadSummaryResponse>(`/workspaces/${workspaceId}/unread-summary`),
    enabled: !!workspaceId,
    // Cheap refetch on focus — the dispatcher already keeps it live, but
    // a long tab-switched session could otherwise drift.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function useMarkChannelRead(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      if (!workspaceId) return;
      await apiRequest(`/workspaces/${workspaceId}/channels/${channelId}/read`, {
        method: 'POST',
      });
      return channelId;
    },
    onSuccess: (channelId) => {
      if (!workspaceId || !channelId) return;
      qc.setQueryData<UnreadSummaryResponse>(qk.channels.unreadSummary(workspaceId), (old) => {
        if (!old) return old;
        return {
          channels: old.channels.map((c) =>
            c.channelId === channelId ? { ...c, unreadCount: 0, hasMention: false } : c,
          ),
        };
      });
    },
  });
}
