import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export type ActivityKind = 'mention' | 'reply' | 'reaction' | 'direct' | 'friend_request';
export type ActivityFilter =
  | 'all'
  | 'mentions'
  | 'replies'
  | 'reactions'
  | 'directs'
  | 'friend_requests';

export interface ActivityRow {
  activityKey: string;
  kind: ActivityKind;
  workspaceId: string;
  channelId: string;
  messageId: string;
  actorId: string;
  snippet: string;
  createdAt: string;
  readAt: string | null;
}

export interface ActivityPage {
  items: ActivityRow[];
  nextCursor: string | null;
}

export interface UnreadCounts {
  total: number;
  mentions: number;
  replies: number;
  reactions: number;
  directs: number;
  friendRequests: number;
}

export function useActivityList(filter: ActivityFilter) {
  return useQuery<ActivityPage>({
    queryKey: ['me', 'activity', filter],
    queryFn: () =>
      apiRequest<ActivityPage>(`/me/activity?filter=${encodeURIComponent(filter)}&limit=50`),
    staleTime: 30_000,
  });
}

export function useActivityUnread() {
  return useQuery<UnreadCounts>({
    queryKey: ['me', 'activity', 'unread-counts'],
    queryFn: () => apiRequest<UnreadCounts>('/me/activity/unread-counts'),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useMarkActivityRead() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (activityKey) => {
      await apiRequest(`/me/activity/${encodeURIComponent(activityKey)}/read`, { method: 'POST' });
    },
    onMutate: async (activityKey) => {
      // Optimistic: flip readAt + decrement counts.
      await qc.cancelQueries({ queryKey: ['me', 'activity'] });
      const previousByFilter: Record<string, ActivityPage | undefined> = {};
      for (const f of [
        'all',
        'mentions',
        'replies',
        'reactions',
        'directs',
        'friend_requests',
      ] as const) {
        const key = ['me', 'activity', f];
        const prev = qc.getQueryData<ActivityPage>(key);
        previousByFilter[f] = prev;
        if (prev) {
          qc.setQueryData<ActivityPage>(key, {
            ...prev,
            items: prev.items.map((i) =>
              i.activityKey === activityKey && !i.readAt
                ? { ...i, readAt: new Date().toISOString() }
                : i,
            ),
          });
        }
      }
      const counts = qc.getQueryData<UnreadCounts>(['me', 'activity', 'unread-counts']);
      if (counts) {
        const all = qc.getQueryData<ActivityPage>(['me', 'activity', 'all']);
        const row = all?.items.find((i) => i.activityKey === activityKey);
        if (row && !row.readAt) {
          qc.setQueryData<UnreadCounts>(['me', 'activity', 'unread-counts'], {
            total: Math.max(0, counts.total - 1),
            mentions: row.kind === 'mention' ? Math.max(0, counts.mentions - 1) : counts.mentions,
            replies: row.kind === 'reply' ? Math.max(0, counts.replies - 1) : counts.replies,
            reactions:
              row.kind === 'reaction' ? Math.max(0, counts.reactions - 1) : counts.reactions,
            directs: row.kind === 'direct' ? Math.max(0, counts.directs - 1) : counts.directs,
            friendRequests:
              row.kind === 'friend_request'
                ? Math.max(0, counts.friendRequests - 1)
                : counts.friendRequests,
          });
        }
      }
      return { previousByFilter };
    },
    onError: (_err, _key, ctx) => {
      const p = (ctx as { previousByFilter?: Record<string, ActivityPage | undefined> })
        ?.previousByFilter;
      if (!p) return;
      for (const [f, data] of Object.entries(p)) {
        if (data) qc.setQueryData(['me', 'activity', f], data);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'activity'] });
    },
  });
}

export function useMarkAllActivityRead() {
  const qc = useQueryClient();
  return useMutation<{ count: number }, Error, ActivityFilter>({
    mutationFn: (filter) =>
      apiRequest<{ count: number }>('/me/activity/read-all', {
        method: 'POST',
        body: { filter },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'activity'] });
    },
  });
}
