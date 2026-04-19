import { apiRequest } from '../../lib/api';
import type {
  CreateInviteRequest,
  CreateWorkspaceRequest,
  Invite,
  InvitePreview,
  Member,
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

export function listMembers(id: string): Promise<{ members: Member[] }> {
  return apiRequest(`/workspaces/${id}/members`);
}

export function updateMemberRole(
  id: string,
  userId: string,
  role: 'ADMIN' | 'MEMBER',
): Promise<Member> {
  return apiRequest(`/workspaces/${id}/members/${userId}/role`, {
    method: 'PATCH',
    body: { role },
  });
}

export function leaveWorkspace(id: string): Promise<void> {
  return apiRequest(`/workspaces/${id}/members/me/leave`, { method: 'POST' });
}

export function createInvite(id: string, input: CreateInviteRequest): Promise<{ invite: Invite; url: string }> {
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
