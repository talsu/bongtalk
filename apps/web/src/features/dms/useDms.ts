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

// 072-N1-4 (FR-DM-04): 검색어를 서버로 전달(`?q=`). q 가 있으면 서버가 참여자
// username + 그룹 displayName/slug 를 ILIKE 매칭한다. q 는 queryKey 에 포함해
// 디바운스된 입력마다 독립 캐시(빈 q 는 파라미터 생략 = 전체 목록).
function dmQs(q: string | undefined): string {
  const trimmed = (q ?? '').trim();
  return trimmed ? `?q=${encodeURIComponent(trimmed)}` : '';
}

export function useDmList(workspaceId: string | undefined, q?: string) {
  return useQuery<{ items: DmListItem[] }>({
    queryKey: ['dm', 'list', workspaceId ?? 'global', q?.trim() || ''],
    queryFn: () => apiRequest(`/me/dms${dmQs(q)}`),
    enabled: true,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

// S16 (FR-DM-03): 그룹 DM 목록. 1:1 useDmList 와 별도 영역으로 분리해 UI 가
// 두 목록을 섞지 않는다. participants(≤5) 로 헤더/아바타 스택을 렌더한다.
export function useDmGroupList(workspaceId: string | undefined, q?: string) {
  return useQuery<{ items: GroupDmListItem[] }>({
    queryKey: ['dm', 'groups', workspaceId ?? 'global', q?.trim() || ''],
    queryFn: () => apiRequest(`/me/dms/groups${dmQs(q)}`),
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

// 072-N1 (적대 리뷰 HIGH): 열린 그룹 DM 의 멤버를 목록과 독립적으로 해석한다.
// GET /me/dms/groups/:gdmId/members 는 멤버 게이트(가시성/q 무관)라 숨긴 그룹의
// 딥링크·검색 중 입력에도 selectedGroup 이 사라지지 않는다(1:1 의 useDmByUser 와
// 대칭). title 폴백·extraNames 를 이 응답으로 구성한다.
export interface GroupMemberProfile {
  userId: string;
  username: string;
  customStatus: string | null;
}

export function useDmGroupMembers(groupId: string | undefined) {
  return useQuery<{ items: GroupMemberProfile[] }>({
    queryKey: ['dm', 'group-members', groupId ?? ''],
    queryFn: () => apiRequest(`/me/dms/groups/${groupId}/members`),
    enabled: !!groupId,
    staleTime: 30_000,
  });
}

/**
 * FR-DM-15: DM 뮤트 해제 mutation. 카노니컬 DELETE /me/mutes/channels/:id (level
 * 오버라이드 보존 로직 포함)를 재사용한다. 성공 시 ['me','mutes'](사이드바 뮤트
 * 집합 useMutedChannelIds)와 DM 목록 쿼리를 무효화해 회색/배지 표시를 갱신한다.
 * (뮤트 *설정* 은 기간 지정 useSetDmMuteUntil 로 일원화 — 072-N1.)
 */
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

// 072-N1-2 (FR-DM-02): 그룹 DM 생성/조회. memberIds 는 본인 제외 2-19 명(서버가
// ≥2·≤19 강제, 초과 시 422 DM_GROUP_CAP_EXCEEDED). 성공 시 그룹 목록을 무효화.
// (workspaceId 인자는 list 캐시 키 호환용 — 전역 그룹은 친구 게이트.)
export function useCreateGroupDm(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<
    { channelId: string; created: boolean; memberIds: string[] },
    Error,
    { memberIds: string[] }
  >({
    mutationFn: (body) => apiRequest(`/me/dms/groups`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dm', 'groups', workspaceId ?? 'global'] });
    },
  });
}

// 072-N1-3 (FR-DM-10): 대화 숨기기/복원. HIDDEN → 사이드바 목록 제외(USER override
// hiddenAt=now). 상대 새 메시지 도착 시 서버가 수신자 hiddenAt 을 자동 복원한다.
// 1:1·그룹 공통. 성공 시 1:1·그룹 목록 둘 다 무효화(채널 종류 모를 수 있어 양쪽).
export function useSetDmVisibility(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<
    { channelId: string; visibility: 'HIDDEN' | 'VISIBLE' },
    Error,
    { channelId: string; visibility: 'HIDDEN' | 'VISIBLE' }
  >({
    mutationFn: ({ channelId, visibility }) =>
      apiRequest(`/me/dms/${channelId}/visibility`, { method: 'PATCH', body: { visibility } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dm', 'list', workspaceId ?? 'global'] });
      void qc.invalidateQueries({ queryKey: ['dm', 'groups', workspaceId ?? 'global'] });
    },
  });
}

// 072-N1-3 (FR-DM-09): 그룹 나가기. 본인을 참여자에서 제거(DELETE participants/me).
// 마지막 멤버가 나가면 서버가 채널을 정리한다. 성공 시 그룹 목록 무효화.
export function useLeaveGroupDm(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (channelId) =>
      apiRequest(`/me/dms/${channelId}/participants/me`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dm', 'groups', workspaceId ?? 'global'] });
    },
  });
}

// 072-N1-3 (FR-DM-11): 기간 지정 뮤트. mutedUntil=ISO8601 → 그 시각까지만, null →
// 무기한(useSetDmMute 와 동일 결과). 1:1·그룹 공통(UserChannelMute 공유). 성공 시
// me/mutes + 1:1·그룹 목록 무효화(회색/배지 갱신).
export function useSetDmMuteUntil(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<
    { channelId: string; mutedUntil: string | null },
    Error,
    { channelId: string; mutedUntil: string | null }
  >({
    mutationFn: ({ channelId, mutedUntil }) =>
      apiRequest(`/me/dms/${channelId}/mute`, { method: 'PATCH', body: { mutedUntil } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'mutes'] });
      void qc.invalidateQueries({ queryKey: ['dm', 'list', workspaceId ?? 'global'] });
      void qc.invalidateQueries({ queryKey: ['dm', 'groups', workspaceId ?? 'global'] });
    },
  });
}
