import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acceptInvite,
  assignRole,
  banMember,
  bulkMemberAction,
  createInvite,
  createRole,
  createWorkspace,
  deleteRole,
  getWorkspace,
  restoreWorkspace,
  softDeleteWorkspace,
  hardDeleteInvite,
  kickMember,
  kickUndo,
  leaveWorkspace,
  listAllMembers,
  listBans,
  listInvites,
  listMembers,
  listMembersDirectory,
  listMyWorkspaces,
  listRoles,
  previewInvite,
  revokeInvite,
  revokeRole,
  timeoutMember,
  transferOwnership,
  unbanMember,
  untimeoutMember,
  updateDefaultChannel,
  updateMemberRole,
  updateRole,
  updateWorkspace,
} from './api';
import type {
  BulkMemberAction,
  CreateRoleRequest,
  MemberDirectorySort,
  UpdateMemberRoleRequest,
  UpdateRoleRequest,
  WorkspaceRole,
} from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';

/**
 * S27 fix-forward(contract HIGH · query-key drift): member-list keys now derive
 * from the single `qk` source so the realtime dispatcher's
 * `qk.workspaces.members(wsId)` invalidate actually hits these queries. The
 * previous local `keys.members` = `['workspace', id, 'members']` (singular,
 * different first segment) never matched the dispatcher's
 * `['workspaces', id, 'members']`, so member invalidations silently no-op'd.
 *
 * Both member hooks hang UNDER `qk.workspaces.members(id)`:
 *   - grouped (presence UI)  → qk.workspaces.members(id)
 *   - complete flat (mention) → [...qk.workspaces.members(id), 'all']
 * so a single `invalidateQueries({ queryKey: qk.workspaces.members(id) })`
 * (prefix match) refreshes both.
 */
const keys = {
  // `mine` stays the distinct `['workspaces', 'mine']` tuple (NOT qk.workspaces
  // .list() = ['workspaces']) so it isn't a prefix of qk.workspaces.members and
  // a "my workspaces" invalidate can't accidentally blow the member caches. The
  // dispatcher's qk.workspaces.list() prefix-invalidate still matches it.
  mine: ['workspaces', 'mine'] as const,
  one: (id: string) => qk.workspaces.detail(id),
  members: (id: string) => qk.workspaces.members(id),
  membersAll: (id: string) => [...qk.workspaces.members(id), 'all'] as const,
  invites: (id: string) => qk.workspaces.invites(id),
  invitePreview: (code: string) => ['invite', code, 'preview'] as const,
  // S61 (D12 / FR-RM01): 역할 목록 캐시 키.
  roles: (id: string) => ['workspaces', id, 'roles'] as const,
  // S63 (D12 / FR-RM06): 차단 목록 캐시 키.
  bans: (id: string) => ['workspaces', id, 'bans'] as const,
};

export function useMyWorkspaces() {
  return useQuery({ queryKey: keys.mine, queryFn: listMyWorkspaces });
}

export function useWorkspace(id: string | undefined) {
  return useQuery({
    queryKey: keys.one(id ?? ''),
    queryFn: () => getWorkspace(id!),
    enabled: !!id,
  });
}

/**
 * S27 fix-forward(regression · @멘션): the COMPLETE flat member list for
 * non-presence consumers (role resolution, @-mention autocomplete, member
 * counts, DM author map). It walks EVERY cursor page with include_offline=true
 * (listAllMembers) so the 51st+ member is mentionable and offline members on a
 * large workspace are never dropped.
 *
 * The previous design flattened only the grouped FIRST page, capping the list
 * at 50 and (on a large workspace) silently dropping every offline member —
 * making them un-mentionable. This hook now has its OWN fetch + key
 * ([...members, 'all']) separate from the presence-scoped grouped list.
 */
export function useMembers(id: string | undefined) {
  return useQuery({
    queryKey: keys.membersAll(id ?? ''),
    queryFn: () => listAllMembers(id!),
    enabled: !!id,
  });
}

/**
 * S27 (FR-P08/P09/P11/P12): grouped, presence-aware member list for the member
 * column UI. Returns the raw hoist + status groups + pagination cursor (the
 * first page; the column consumes the authoritative groups the server builds
 * over the whole member set).
 */
export function useMemberGroups(id: string | undefined) {
  return useQuery({
    queryKey: keys.members(id ?? ''),
    queryFn: () => listMembers(id!),
    enabled: !!id,
  });
}

/**
 * S69 (D13 / FR-W10 · Fork D): 멤버 디렉터리 무한 쿼리. 전체로드(useMembers) 대신
 * 서버 검색/필터/정렬 API 를 커서로 페이지네이션한다. 열람은 모든 멤버 가능.
 */
export function useMembersDirectory(
  id: string | undefined,
  params: { q?: string; role?: WorkspaceRole; sortBy?: MemberDirectorySort } = {},
) {
  return useInfiniteQuery({
    queryKey: qk.workspaces.directory(id ?? '', {
      q: params.q,
      role: params.role,
      sortBy: params.sortBy,
    }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listMembersDirectory(id!, { ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!id,
  });
}

/**
 * S69 (D13 / FR-W11): 일괄 멤버 관리. 성공 시 디렉터리·멤버 그룹·unread 총합 캐시를
 * 무효화해 강퇴/역할변경/타임아웃 후 목록을 갱신한다.
 */
export function useBulkMemberAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      action: BulkMemberAction;
      userIds: string[];
      durationSeconds?: number;
      role?: 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
    }) => bulkMemberAction(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces', id, 'directory'] });
      qc.invalidateQueries({ queryKey: keys.members(id) });
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
    },
  });
}

export function useInvites(id: string | undefined) {
  return useQuery({
    queryKey: keys.invites(id ?? ''),
    queryFn: () => listInvites(id!),
    enabled: !!id,
  });
}

export function useInvitePreview(code: string | undefined) {
  return useQuery({
    queryKey: keys.invitePreview(code ?? ''),
    queryFn: () => previewInvite(code!),
    enabled: !!code,
    retry: false,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

export function useUpdateWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof updateWorkspace>[1]) => updateWorkspace(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.one(id) });
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

export function useUpdateRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    // S61 fix-forward (contract): 5단계 시스템 역할(OWNER 제외) 배정 — shared-types
    // UpdateMemberRoleRequest['role'] 로 묶어 MODERATOR/GUEST 도 배정 가능.
    mutationFn: ({ userId, role }: { userId: string; role: UpdateMemberRoleRequest['role'] }) =>
      updateMemberRole(id, userId, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

export function useCreateInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createInvite>[1]) => createInvite(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.invites(id) });
    },
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: acceptInvite,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

// S67 (D13 / FR-W17): 초대 비활성화(soft revoke). 목록 캐시를 무효화한다.
export function useRevokeInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokeInvite(id, inviteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.invites(id) });
    },
  });
}

// S67 (D13 / FR-W17 · Fork C-2): 초대 영구 삭제(hard delete). 목록 캐시를 무효화한다.
export function useHardDeleteInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => hardDeleteInvite(id, inviteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.invites(id) });
    },
  });
}

// ── S61 (D12 / FR-RM01·04·15): 역할 관리 hooks ────────────────────────────────

export function useRoles(id: string | undefined) {
  return useQuery({
    queryKey: keys.roles(id ?? ''),
    queryFn: () => listRoles(id!),
    enabled: !!id,
  });
}

export function useCreateRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleRequest) => createRole(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.roles(id) });
    },
  });
}

export function useUpdateRole2(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roleId, input }: { roleId: string; input: UpdateRoleRequest }) =>
      updateRole(id, roleId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.roles(id) });
    },
  });
}

export function useDeleteRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) => deleteRole(id, roleId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.roles(id) });
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

export function useAssignRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roleId, userId }: { roleId: string; userId: string }) =>
      assignRole(id, roleId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

export function useRevokeRole(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targetUserId, roleId }: { targetUserId: string; roleId: string }) =>
      revokeRole(id, targetUserId, roleId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

export function useLeaveWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => leaveWorkspace(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

// S72 (D13 / FR-W15): 워크스페이스 소프트 삭제(OWNER). confirmation(= slug) 일치 시 202.
// 성공하면 내 워크스페이스 목록을 무효화해 사이드바에서 제거한다(라우터/호출부가 리다이렉트).
export function useDeleteWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirmation: string) => softDeleteWorkspace(id, confirmation),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
      qc.invalidateQueries({ queryKey: keys.one(id) });
    },
  });
}

// S72 (D13 / FR-W15): grace 기간 내 워크스페이스 복원(OWNER). 성공하면 목록/상세를
// 무효화해 사이드바에 복귀시킨다.
export function useRestoreWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => restoreWorkspace(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mine });
      qc.invalidateQueries({ queryKey: keys.one(id) });
    },
  });
}

// S65 (D13 / FR-W13): 소유권 양도(비밀번호 재확인). 양도 후 내 역할(ADMIN)·소유자가
// 바뀌므로 워크스페이스 상세 + 멤버 목록 캐시를 무효화한다.
export function useTransferOwnership(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ toUserId, password }: { toUserId: string; password: string }) =>
      transferOwnership(id, toUserId, password),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.one(id) });
      qc.invalidateQueries({ queryKey: keys.members(id) });
      qc.invalidateQueries({ queryKey: keys.mine });
    },
  });
}

// S65 (D13 / FR-W19): 기본 채널 변경. 상세(defaultChannelId) + 채널 목록(isDefault
// 토글)을 무효화한다.
export function useUpdateDefaultChannel(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (defaultChannelId: string) => updateDefaultChannel(id, defaultChannelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.one(id) });
      qc.invalidateQueries({ queryKey: qk.channels.list(id) });
    },
  });
}

// ── S63 (D12 / FR-RM05·06·07): 모더레이션 hooks ───────────────────────────────

/** FR-RM05: 멤버 강제 퇴장. 5초 Undo 토큰을 반환한다(호출부가 토스트로 노출). */
export function useKickMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason?: string }) =>
      kickMember(id, userId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

/** FR-RM05: kick 5초 Undo(재가입). */
export function useKickUndo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, undoToken }: { userId: string; undoToken: string }) =>
      kickUndo(id, userId, undoToken),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

/** FR-RM06: userId 영구 차단. */
export function useBanMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason?: string }) =>
      banMember(id, userId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
      qc.invalidateQueries({ queryKey: keys.bans(id) });
    },
  });
}

/** FR-RM06: 차단 해제. */
export function useUnbanMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => unbanMember(id, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.bans(id) });
    },
  });
}

/** FR-RM06: 차단 목록(권한자). */
export function useBans(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.bans(id ?? ''),
    queryFn: () => listBans(id!),
    enabled: !!id && enabled,
  });
}

/** FR-RM07: 멤버 임시 음소거. */
export function useTimeoutMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      durationSeconds,
      reason,
    }: {
      userId: string;
      durationSeconds: number;
      reason?: string;
    }) => timeoutMember(id, userId, durationSeconds, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}

/** FR-RM07: 음소거 수동 해제. */
export function useUntimeoutMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => untimeoutMember(id, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members(id) });
    },
  });
}
