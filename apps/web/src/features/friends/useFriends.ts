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
    onSuccess: () => {
      invalidate(qc);
      // S75 fix-forward (F13): 차단 해제 후엔 채널/DM 메시지 캐시도 무효화해야
      // 서버가 더 이상 마스킹하지 않는 원문이 다시 표시된다. 종전엔 ['friends']
      // 만 무효화해 열린 채널 메시지가 `[차단된 사용자의 메시지]` placeholder 로
      // 남아 있었다(서버는 이미 원문을 돌려주지만 stale 캐시가 가렸다).
      void qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}
