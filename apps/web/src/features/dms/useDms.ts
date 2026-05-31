import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';

export interface DmParticipantProfile {
  userId: string;
  username: string;
}

export interface DmListItem {
  channelId: string;
  otherUserId: string;
  otherUsername: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  // S16 (FR-DM-03): 참여자 프로필. 1:1 DM 은 상대방 단일 요소(항상 1개).
  participants: DmParticipantProfile[];
}

// S16 (FR-DM-03): GET /me/dms/groups 항목. memberIds 는 전체 멤버 id(권한·라우팅),
// participants 는 표시용 username 슬라이스(≤5) — 서버 listGroups shape 과 동기화.
export interface GroupDmListItem {
  channelId: string;
  memberIds: string[];
  participants: DmParticipantProfile[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
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

// S16 (FR-DM-03): 그룹 DM 목록. 1:1 useDmList 와 별도 영역으로 분리해 UI 가
// 두 목록을 섞지 않는다. participants(≤5) 로 헤더/아바타 스택을 렌더한다.
export function useDmGroupList(workspaceId: string | undefined) {
  return useQuery<{ items: GroupDmListItem[] }>({
    queryKey: ['dm', 'groups', workspaceId ?? 'global'],
    queryFn: () => apiRequest(`/me/dms/groups`),
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
