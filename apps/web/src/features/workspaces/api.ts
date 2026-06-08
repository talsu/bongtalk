import { apiRequest } from '../../lib/api';
import type {
  AcceptEmailInviteResponse,
  AcceptInviteResponse,
  BulkMemberAction,
  BulkMemberActionResponse,
  CreateInviteRequest,
  CreateRoleRequest,
  CreateWorkspaceRequest,
  DeleteWorkspaceResponse,
  EmailInviteRole,
  ExchangeEmailInviteResponse,
  Invite,
  InviteByEmailResponse,
  InvitePreview,
  ListMemberDirectoryResponse,
  ListPendingInvitesResponse,
  MemberDirectorySort,
  PendingInviteAction,
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
  WorkspaceRole,
  WorkspaceWithMyRole,
  ApplicationAnswer,
  ApplicationStatus,
  ListApplicationsResponse,
  MyApplicationResponse,
  ProcessApplicationAction,
  WorkspaceMemberApplication,
  AutoModRule,
  CreateAutoModRuleRequest,
  UpdateAutoModRuleRequest,
  ListAutoModRulesResponse,
} from '@qufox/shared-types';

// S65 (D13 / FR-W13): 소유권 양도는 비밀번호 재확인을 강제한다(서버 argon2 verify).
export function transferOwnership(
  id: string,
  toUserId: string,
  password: string,
): Promise<unknown> {
  return apiRequest(`/workspaces/${id}/transfer-ownership`, {
    method: 'POST',
    body: { toUserId, password },
  });
}

// S65 (D13 / FR-W19): 워크스페이스 기본 채널 변경(OWNER). 대상은 공개 채널이어야 한다.
export function updateDefaultChannel(id: string, defaultChannelId: string): Promise<Workspace> {
  return apiRequest(`/workspaces/${id}/default-channel`, {
    method: 'PATCH',
    body: { defaultChannelId },
  });
}

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

// S72 (D13 / FR-W15): 워크스페이스 소프트 삭제(OWNER). 파괴적 액션이라 confirmation
// (= 워크스페이스 slug)을 body 로 보낸다. 서버가 confirmation !== slug 면 422
// (WORKSPACE_CONFIRMATION_MISMATCH)로 거부한다. 성공 시 202 + grace 종료 시각 deleteAt.
export function softDeleteWorkspace(
  id: string,
  confirmation: string,
): Promise<DeleteWorkspaceResponse> {
  return apiRequest(`/workspaces/${id}`, { method: 'DELETE', body: { confirmation } });
}

// S72 (D13 / FR-W15): grace 기간 내 워크스페이스 복원(OWNER). 성공 시 복원된 Workspace.
export function restoreWorkspace(id: string): Promise<Workspace> {
  return apiRequest(`/workspaces/${id}/restore`, { method: 'POST' });
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

// S69 (D13 / FR-W10): 멤버 디렉터리 — 검색/역할필터/가입일정렬/커서. 전체로드(listAllMembers)
// 대신 서버 검색/필터 API 를 직접 페이지네이션한다(Fork D). 열람은 모든 멤버 가능.
export function listMembersDirectory(
  id: string,
  opts: {
    q?: string;
    role?: WorkspaceRole;
    sortBy?: MemberDirectorySort;
    cursor?: string;
  } = {},
): Promise<ListMemberDirectoryResponse> {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.role) params.set('role', opts.role);
  if (opts.sortBy) params.set('sortBy', opts.sortBy);
  if (opts.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  return apiRequest(`/workspaces/${id}/members/directory${qs ? `?${qs}` : ''}`);
}

// S69 (D13 / FR-W11): 일괄 멤버 관리(kick/timeout/role · 최대 100명). 단일 tx 응답에
// affected/skipped 가 함께 담겨 부분실패를 FE 가 표시한다.
export function bulkMemberAction(
  id: string,
  input: {
    action: BulkMemberAction;
    userIds: string[];
    durationSeconds?: number;
    role?: 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
  },
): Promise<BulkMemberActionResponse> {
  return apiRequest(`/workspaces/${id}/members/bulk-action`, {
    method: 'POST',
    body: input,
  });
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

// S67 (D13 / FR-W03): 수락 응답은 { workspace, alreadyMember }. 신규 가입과 이미 멤버였던
// 멱등 수락(200) 모두 workspace 를 담으므로 FE 는 alreadyMember 로 안내만 분기한다.
export function acceptInvite(code: string): Promise<AcceptInviteResponse> {
  return apiRequest(`/invites/${code}/accept`, { method: 'POST' });
}

// S67 (D13 / FR-W17): 비활성화(soft revoke) — revokedAt 을 찍는다(204).
export function revokeInvite(id: string, inviteId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/invites/${inviteId}`, { method: 'DELETE' });
}

// S67 (D13 / FR-W17 · Fork C-2): 영구 삭제(hard delete) — 행을 제거한다(204).
export function hardDeleteInvite(id: string, inviteId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/invites/${inviteId}/permanent`, { method: 'DELETE' });
}

// ── S68 (D13 / FR-W04·W04a·W18): 이메일 직접 초대 + 보류 초대 관리 ────────────────

// FR-W04: 이메일 일괄 직접 초대(최대 50). 부분성공 응답({ results, sentCount, … }).
export function inviteByEmail(
  id: string,
  emails: string[],
  role: EmailInviteRole,
): Promise<InviteByEmailResponse> {
  return apiRequest(`/workspaces/${id}/invite-by-email`, {
    method: 'POST',
    body: { emails, role },
  });
}

// FR-W18: 보류 초대 목록(ADMIN+).
export function listPendingInvites(id: string): Promise<ListPendingInvitesResponse> {
  return apiRequest(`/workspaces/${id}/pending-invites`);
}

// FR-W18: 개별 보류 초대 연장(+30일)/재발송(204).
export function updatePendingInvite(
  id: string,
  pendingId: string,
  action: PendingInviteAction,
): Promise<void> {
  return apiRequest(`/workspaces/${id}/pending-invites/${pendingId}`, {
    method: 'PATCH',
    body: { action },
  });
}

// FR-W18: 보류 초대 취소(soft, 204).
export function cancelPendingInvite(id: string, pendingId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/pending-invites/${pendingId}`, { method: 'DELETE' });
}

// FR-W04a 분기 ②③: rawToken 직접 수락(로그인 사용자). slug 는 표시용·권위는 토큰.
export function acceptEmailInvite(slug: string, token: string): Promise<AcceptEmailInviteResponse> {
  return apiRequest(`/workspaces/${slug}/accept-email-invite`, {
    method: 'POST',
    body: { token },
  });
}

// FR-W04a 분기 ①: rawToken → 단기 opaque 코드 교환(회원가입 리다이렉트용).
export function exchangeEmailInviteToken(
  slug: string,
  token: string,
): Promise<ExchangeEmailInviteResponse> {
  return apiRequest(`/workspaces/${slug}/exchange-invite-token`, {
    method: 'POST',
    body: { token },
  });
}

// FR-W04a 분기 ①(가입 후): opaque 코드로 자동 수락.
export function acceptEmailInviteByOpaque(
  slug: string,
  opaqueCode: string,
): Promise<AcceptEmailInviteResponse> {
  return apiRequest(`/workspaces/${slug}/accept-email-invite-opaque`, {
    method: 'POST',
    body: { token: opaqueCode },
  });
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

// ── FR-RM10a (063): AutoMod 키워드 규칙 관리 ──────────────────────────────────

export function listAutoModRules(id: string): Promise<ListAutoModRulesResponse> {
  return apiRequest(`/workspaces/${id}/automod-rules`);
}

export function createAutoModRule(
  id: string,
  input: CreateAutoModRuleRequest,
): Promise<AutoModRule> {
  return apiRequest(`/workspaces/${id}/automod-rules`, { method: 'POST', body: input });
}

export function updateAutoModRule(
  id: string,
  ruleId: string,
  input: UpdateAutoModRuleRequest,
): Promise<AutoModRule> {
  return apiRequest(`/workspaces/${id}/automod-rules/${ruleId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteAutoModRule(id: string, ruleId: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/automod-rules/${ruleId}`, { method: 'DELETE' });
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

// ── S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) ─────────────────────────────
// 경로는 PRD 정본대로 :slug 를 쓴다(다른 워크스페이스 API 의 :id 와 별개).

/** FR-W06: 가입 신청 제출(커스텀 질문 응답 최대 5개). 이미 신청 중이면 409. */
export function submitApplication(
  slug: string,
  answers: ApplicationAnswer[],
): Promise<WorkspaceMemberApplication> {
  return apiRequest(`/workspaces/${slug}/applications`, { method: 'POST', body: { answers } });
}

/** FR-W06: 신청 목록(ADMIN+). status 필터 선택. */
export function listApplications(
  slug: string,
  status?: ApplicationStatus,
): Promise<ListApplicationsResponse> {
  const qs = status ? `?status=${status}` : '';
  return apiRequest(`/workspaces/${slug}/applications${qs}`);
}

/** FR-W06a: 본인 신청 상태 조회(WS 끊김 시 30초 polling fallback). */
export function getMyApplication(slug: string): Promise<MyApplicationResponse> {
  return apiRequest(`/workspaces/${slug}/applications/me`);
}

/** FR-W06: 신청 처리. approve/interview 는 ADMIN+, reject 는 MODERATOR+. */
export function processApplication(
  slug: string,
  applicationId: string,
  action: ProcessApplicationAction,
  reviewNote?: string,
): Promise<WorkspaceMemberApplication> {
  return apiRequest(`/workspaces/${slug}/applications/${applicationId}`, {
    method: 'PATCH',
    body: { action, ...(reviewNote !== undefined ? { reviewNote } : {}) },
  });
}

/** FR-W06: 신청 취소(본인, PENDING → WITHDRAWN). */
export function withdrawApplication(
  slug: string,
  applicationId: string,
): Promise<WorkspaceMemberApplication> {
  return apiRequest(`/workspaces/${slug}/applications/${applicationId}`, { method: 'DELETE' });
}
