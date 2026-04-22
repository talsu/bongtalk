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

export function useDmList(workspaceId: string | undefined) {
  return useQuery<{ items: DmListItem[] }>({
    queryKey: ['dm', 'list', workspaceId],
    queryFn: () => apiRequest(`/me/workspaces/${workspaceId}/dms`),
    enabled: !!workspaceId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useDmByUser(workspaceId: string | undefined, userId: string | undefined) {
  return useQuery<{ channelId: string | null }>({
    queryKey: ['dm', 'by-user', workspaceId, userId],
    queryFn: () => apiRequest(`/me/workspaces/${workspaceId}/dms/by-user/${userId}`),
    enabled: !!workspaceId && !!userId,
    staleTime: 60_000,
  });
}

export function useCreateOrGetDm(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ channelId: string; created: boolean }, Error, { userId: string }>({
    mutationFn: (body) => apiRequest(`/me/workspaces/${workspaceId}/dms`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dm', 'list', workspaceId] });
    },
  });
}
