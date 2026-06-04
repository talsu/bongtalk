import { apiRequest } from '../../lib/api';
import type {
  CreateInviteRequest,
  CreateRoleRequest,
  CreateWorkspaceRequest,
  Invite,
  InvitePreview,
  KickMemberResponse,
  ListAuditLogsResponse,
  ListBansResponse,
  ListMembersResponse,
  ListReportsResponse,
  Member,
  MemberWithPresence,
  ReportAction,
  ReportQueueFilter,
  Role,
  TimeoutMemberResponse,
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
// S63 (FR-RM07): 반환 타입을 MemberWithPresence[] 로 둔다 — grouped 응답 행은
// status/lastSeenAt/mutedUntil(타임아웃 배지)을 함께 싣는다(base Member 의 상위집합).
export async function listAllMembers(id: string): Promise<{ members: MemberWithPresence[] }> {
  const members: MemberWithPresence[] = [];
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

// ── S63 (D12 / FR-RM05·06·07): 모더레이션(Kick/Ban/Timeout) ─────────────────────

/** FR-RM05: 멤버 강제 퇴장. actor 에게만 5초 Undo 토큰을 반환한다. */
export function kickMember(
  id: string,
  userId: string,
  reason?: string,
): Promise<KickMemberResponse> {
  return apiRequest(`/workspaces/${id}/moderation/members/${userId}/kick`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

/** FR-RM05: kick 5초 Undo. */
export function kickUndo(id: string, userId: string, undoToken: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/moderation/members/${userId}/kick-undo`, {
    method: 'POST',
    body: { undoToken },
  });
}

/** FR-RM06: userId 영구 차단(멤버/비멤버). */
export function banMember(id: string, userId: string, reason?: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/moderation/bans`, {
    method: 'POST',
    body: reason ? { userId, reason } : { userId },
  });
}

/** FR-RM06: 차단 해제. */
export function unbanMember(id: string, userId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/moderation/bans/${userId}`, { method: 'DELETE' });
}

/** FR-RM06: 차단 목록(권한자). */
export function listBans(id: string): Promise<ListBansResponse> {
  return apiRequest(`/workspaces/${id}/moderation/bans`);
}

/** FR-RM07: 멤버 임시 음소거(60~604800초). */
export function timeoutMember(
  id: string,
  userId: string,
  durationSeconds: number,
  reason?: string,
): Promise<TimeoutMemberResponse> {
  return apiRequest(`/workspaces/${id}/moderation/members/${userId}/timeout`, {
    method: 'POST',
    body: reason ? { durationSeconds, reason } : { durationSeconds },
  });
}

/** FR-RM07: 음소거 수동 해제. */
export function untimeoutMember(id: string, userId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/moderation/members/${userId}/timeout`, { method: 'DELETE' });
}

// ── S64 (D12 / FR-RM11·12): 신고 큐 + 감사 로그 조회 ──────────────────────────

/** FR-RM12: 감사 로그 cursor 페이지 조회(ADMIN+). action/actor 필터 선택. */
export function listAuditLogs(
  id: string,
  opts: { cursor?: string; limit?: number; action?: string; actorId?: string } = {},
): Promise<ListAuditLogsResponse> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.action) params.set('action', opts.action);
  if (opts.actorId) params.set('actorId', opts.actorId);
  const qs = params.toString();
  return apiRequest(`/workspaces/${id}/audit-logs${qs ? `?${qs}` : ''}`);
}

/** FR-RM11: 신고 큐 열람(MODERATOR+). filter=OPEN(미처리) / ALL. */
export function listReports(
  id: string,
  filter: ReportQueueFilter = 'OPEN',
): Promise<ListReportsResponse> {
  return apiRequest(`/workspaces/${id}/moderation/reports?filter=${filter}`);
}

/** FR-RM11: 신고 처리(DISMISS/WARN/DELETE_MESSAGE/TIMEOUT/BAN). MODERATOR+. */
export function resolveReport(
  id: string,
  reportId: string,
  input: { action: ReportAction; reason?: string; durationSeconds?: number },
): Promise<void> {
  return apiRequest(`/workspaces/${id}/moderation/reports/${reportId}/resolve`, {
    method: 'POST',
    body: input,
  });
}
