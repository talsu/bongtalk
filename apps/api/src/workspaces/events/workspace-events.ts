export const WORKSPACE_CREATED = 'workspace.created';
export const WORKSPACE_DELETED = 'workspace.deleted';
export const WORKSPACE_RESTORED = 'workspace.restored';
export const MEMBER_JOINED = 'workspace.member.joined';
export const MEMBER_LEFT = 'workspace.member.left';
export const MEMBER_REMOVED = 'workspace.member.removed';
export const ROLE_CHANGED = 'workspace.role.changed';
export const OWNERSHIP_TRANSFERRED = 'workspace.ownership.transferred';
export const INVITE_CREATED = 'workspace.invite.created';
export const INVITE_REVOKED = 'workspace.invite.revoked';
export const INVITE_ACCEPTED = 'workspace.invite.accepted';

export type WorkspaceCreatedEvent = {
  workspaceId: string;
  ownerId: string;
  slug: string;
};
export type WorkspaceDeletedEvent = {
  workspaceId: string;
  actorId: string;
  deleteAt: Date;
};
export type MemberChangedEvent = {
  workspaceId: string;
  userId: string;
  actorId: string;
};
export type RoleChangedEvent = {
  workspaceId: string;
  userId: string;
  actorId: string;
  from: string;
  to: string;
};
export type InviteEvent = {
  workspaceId: string;
  inviteId: string;
  actorId: string;
};
