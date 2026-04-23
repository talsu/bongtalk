import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export type FriendsFilter = 'accepted' | 'pending_incoming' | 'pending_outgoing' | 'blocked';
export type FriendStatus = 'PENDING' | 'ACCEPTED' | 'BLOCKED';

export interface FriendRow {
  friendshipId: string;
  otherUserId: string;
  otherUsername: string;
  status: FriendStatus;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

export function useFriendsList(filter: FriendsFilter) {
  return useQuery<{ items: FriendRow[] }>({
    queryKey: ['friends', filter],
    queryFn: () => apiRequest(`/me/friends?status=${encodeURIComponent(filter)}`),
    staleTime: 15_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['friends'] });
}

export function useRequestFriend() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { username: string }>({
    mutationFn: (body) => apiRequest('/me/friends/requests', { method: 'POST', body }),
    onSuccess: () => invalidate(qc),
  });
}

export function useAcceptFriend() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { friendshipId: string }>({
    mutationFn: ({ friendshipId }) =>
      apiRequest(`/me/friends/${friendshipId}/accept`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}

export function useRejectFriend() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { friendshipId: string }>({
    mutationFn: ({ friendshipId }) =>
      apiRequest(`/me/friends/${friendshipId}/reject`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}

export function useRemoveFriend() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { friendshipId: string }>({
    mutationFn: ({ friendshipId }) =>
      apiRequest(`/me/friends/${friendshipId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(qc),
  });
}

export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { userId: string }>({
    mutationFn: ({ userId }) => apiRequest(`/me/friends/block/${userId}`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
  });
}

export function useUnblockUser() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { userId: string }>({
    mutationFn: ({ userId }) => apiRequest(`/me/friends/block/${userId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(qc),
  });
}
