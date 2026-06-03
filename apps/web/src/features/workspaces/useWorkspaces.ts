import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acceptInvite,
  assignRole,
  createInvite,
  createRole,
  createWorkspace,
  deleteRole,
  getWorkspace,
  leaveWorkspace,
  listAllMembers,
  listInvites,
  listMembers,
  listMyWorkspaces,
  listRoles,
  previewInvite,
  revokeRole,
  updateMemberRole,
  updateRole,
  updateWorkspace,
} from './api';
import type { CreateRoleRequest, UpdateRoleRequest } from '@qufox/shared-types';
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
    mutationFn: ({ userId, role }: { userId: string; role: 'ADMIN' | 'MEMBER' }) =>
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
