import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export interface MentionSummary {
  messageId: string;
  channelId: string;
  workspaceId: string;
  authorId: string;
  snippet: string;
  createdAt: string;
  everyone: boolean;
}

export interface MentionInboxResponse {
  unreadCount: number;
  recent: MentionSummary[];
}

/**
 * Task-011-B: mention inbox + unread count. Dispatcher mutates the
 * cache when `mention.received` arrives over WS; this hook is the
 * plain read path.
 */
export function useMentionInbox() {
  return useQuery({
    queryKey: ['me', 'mentions'] as const,
    queryFn: () => apiRequest<MentionInboxResponse>('/me/mentions'),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}
