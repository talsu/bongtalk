import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export interface DmListItem {
  channelId: string;
  otherUserId: string;
  otherUsername: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

// task-037-A: all DM hooks now hit the Global DM surface at /me/dms.
// The workspaceId argument is retained for call-site compatibility
// but ignored — the server picks the implicit host via friendship.

export function useDmList(workspaceId: string | undefined) {
  return useQuery<{ items: DmListItem[] }>({
    queryKey: ['dm', 'list', workspaceId ?? 'global'],
    queryFn: () => apiRequest(`/me/dms`),
    enabled: true,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useDmByUser(workspaceId: string | undefined, userId: string | undefined) {
  return useQuery<{ channelId: string | null }>({
    queryKey: ['dm', 'by-user', workspaceId ?? 'global', userId],
    queryFn: () => apiRequest(`/me/dms/by-user/${userId}`),
    enabled: !!userId,
    staleTime: 60_000,
  });
}

export function useCreateOrGetDm(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ channelId: string; created: boolean }, Error, { userId: string }>({
    mutationFn: (body) => apiRequest(`/me/dms`, { method: 'POST', body }),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ['dm', 'list', workspaceId ?? 'global'] });
      // Also invalidate the /me/dms/by-user cache so DmShell's inline
      // channel resolver picks up the newly-created channelId without
      // the user having to refresh or re-click.
      void qc.invalidateQueries({
        queryKey: ['dm', 'by-user', workspaceId ?? 'global', vars.userId],
      });
    },
  });
}
