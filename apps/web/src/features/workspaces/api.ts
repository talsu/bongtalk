import { apiRequest } from '../../lib/api';
import type {
  CreateInviteRequest,
  CreateRoleRequest,
  CreateWorkspaceRequest,
  Invite,
  InvitePreview,
  ListMembersResponse,
  Member,
  Role,
  UpdateMemberRoleRequest,
  UpdateRoleRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceWithMyRole,
} from '@qufox/shared-types';

export function listMyWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  return apiRequest('/workspaces');
}

export function createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace> {
  return apiRequest('/workspaces', { method: 'POST', body: input });
}

export function getWorkspace(id: string): Promise<WorkspaceWithMyRole> {
  return apiRequest(`/workspaces/${id}`);
}

export function updateWorkspace(id: string, input: UpdateWorkspaceRequest): Promise<Workspace> {
  return apiRequest(`/workspaces/${id}`, { method: 'PATCH', body: input });
}

export function softDeleteWorkspace(id: string): Promise<{ deleteAt: string }> {
  return apiRequest(`/workspaces/${id}`, { method: 'DELETE' });
}

// S27 (FR-P08/P09/P11/P12): grouped, presence-aware, paginated member list.
export function listMembers(
  id: string,
  opts: { cursor?: string; includeOffline?: boolean } = {},
): Promise<ListMembersResponse> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.includeOffline !== undefined) params.set('include_offline', String(opts.includeOffline));
  const qs = params.toString();
  return apiRequest(`/workspaces/${id}/members${qs ? `?${qs}` : ''}`);
}

/**
 * S27 fix-forward(regression · @멘션): the COMPLETE flat member set for the
 * workspace. Non-presence consumers (mention autocomplete, member counts, role
 * resolution, DM author map) must see EVERY member — never the 50-row first
 * page of the grouped list (which would cap mentions at 50 and silently drop
 * offline members on a large workspace). We always opt into include_offline and
 * walk every cursor page, flattening hoist + status groups into one array.
 *
 * A hard page-walk bound stops a pathological loop; in practice the list is the
 * workspace member count and pages are 50 each.
 */
export async function listAllMembers(id: string): Promise<{ members: Member[] }> {
  const members: Member[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const res = await listMembers(id, { cursor, includeOffline: true });
    for (const g of res.hoist) members.push(...g.members);
    for (const g of res.groups) members.push(...g.members);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return { members };
}

// S61 fix-forward (contract BLOCKER/HIGH): 시스템 역할 5단계로 확장돼 MODERATOR/GUEST
// 도 직접 배정 가능하다(OWNER 는 transfer-ownership 전용). 역할 타입을 shared-types
// UpdateMemberRoleRequest['role'] 로 묶어 FE/BE 가 단일 출처를 공유한다.
export function updateMemberRole(
  id: string,
  userId: string,
  role: UpdateMemberRoleRequest['role'],
): Promise<Member> {
  return apiRequest(`/workspaces/${id}/members/${userId}/role`, {
    method: 'PATCH',
    body: { role },
  });
}

export function leaveWorkspace(id: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/members/me/leave`, { method: 'POST' });
}

export function createInvite(
  id: string,
  input: CreateInviteRequest,
): Promise<{ invite: Invite; url: string }> {
  return apiRequest(`/workspaces/${id}/invites`, { method: 'POST', body: input });
}

export function listInvites(id: string): Promise<{ invites: Invite[] }> {
  return apiRequest(`/workspaces/${id}/invites`);
}

export function previewInvite(code: string): Promise<InvitePreview> {
  // Preview is @Public on the server but apiRequest still works (no access token
  // just means no Authorization header — that's fine).
  return apiRequest(`/invites/${code}`, { retryOn401: false });
}

export function acceptInvite(code: string): Promise<{ workspace: Workspace }> {
  return apiRequest(`/invites/${code}/accept`, { method: 'POST' });
}

// ── S61 (D12 / FR-RM01·04·15): 역할 관리 ──────────────────────────────────────

export function listRoles(id: string): Promise<Role[]> {
  return apiRequest(`/workspaces/${id}/roles`);
}

export function createRole(id: string, input: CreateRoleRequest): Promise<Role> {
  return apiRequest(`/workspaces/${id}/roles`, { method: 'POST', body: input });
}

export function updateRole(id: string, roleId: string, input: UpdateRoleRequest): Promise<Role> {
  return apiRequest(`/workspaces/${id}/roles/${roleId}`, { method: 'PATCH', body: input });
}

export function deleteRole(id: string, roleId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/roles/${roleId}`, { method: 'DELETE' });
}

export function assignRole(id: string, roleId: string, userId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/roles/assign`, {
    method: 'POST',
    body: { roleId, userId },
  });
}

export function revokeRole(id: string, targetUserId: string, roleId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/roles/assign/${targetUserId}/${roleId}`, {
    method: 'DELETE',
  });
}
