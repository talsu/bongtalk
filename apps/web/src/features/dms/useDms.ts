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
  // FR-DM-15: 미읽음 @멘션 건수(뮤트 DM 배지용). 서버가 점진 롤아웃 중일 수 있어
  // 소비처(DmShell/MobileDmList)는 `?? 0` 으로 안전 폴백한다(dmRowBadge 입력).
  mentionCount: number;
  // S16 (FR-DM-03): 참여자 프로필. 1:1 DM 은 상대방 단일 요소(항상 1개).
  participants: DmParticipantProfile[];
}

// S16 (FR-DM-03): GET /me/dms/groups 항목. memberIds 는 전체 멤버 id(권한·라우팅),
// participants 는 표시용 username 슬라이스(≤5) — 서버 listGroups shape 과 동기화.
export interface GroupDmListItem {
  channelId: string;
  memberIds: string[];
  participants: DmParticipantProfile[];
  // S20 (FR-DM-05/06, contract fix-forward): 서버 listGroups 가 반환하는 사용자
  // 지정 표시명 + 아이콘 키. displayName 이 null 이면 클라가 멤버 username 으로
  // 폴백 렌더, iconUrl 이 null 이면 기본 아바타. (iconUrl 은 현재 raw 키 — web
  // 소비 훅 dormant 라 미렌더이며, presign-on-read 배선은 carryover.)
  displayName: string | null;
  iconUrl: string | null;
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

/**
 * FR-DM-15: DM 뮤트 설정/해제 mutation. 채널 뮤트(useMutes)와 동일한
 * UserChannelMute 테이블을 쓰지만, 설정은 DM 전용 라우트(PATCH /me/dms/:channelId/
 * mute {mutedUntil:null}=무기한)를, 해제는 카노니컬 DELETE /me/mutes/channels/:id
 * (level 오버라이드 보존 로직 포함)를 재사용한다. 성공 시 ['me','mutes'](사이드바
 * 뮤트 집합 useMutedChannelIds)와 DM 목록 쿼리를 무효화해 회색/배지 표시를 갱신한다.
 */
export function useSetDmMute(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ channelId: string; mutedUntil: string | null }, Error, string>({
    mutationFn: (channelId) =>
      apiRequest(`/me/dms/${channelId}/mute`, { method: 'PATCH', body: { mutedUntil: null } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'mutes'] });
      void qc.invalidateQueries({ queryKey: ['dm', 'list', workspaceId ?? 'global'] });
    },
  });
}

export function useRemoveDmMute(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (channelId) => apiRequest(`/me/mutes/channels/${channelId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'mutes'] });
      void qc.invalidateQueries({ queryKey: ['dm', 'list', workspaceId ?? 'global'] });
    },
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
