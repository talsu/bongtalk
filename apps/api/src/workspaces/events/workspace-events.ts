export const WORKSPACE_CREATED = 'workspace.created';
export const WORKSPACE_DELETED = 'workspace.deleted';
export const WORKSPACE_RESTORED = 'workspace.restored';
export const MEMBER_JOINED = 'workspace.member.joined';
export const MEMBER_LEFT = 'workspace.member.left';
export const MEMBER_REMOVED = 'workspace.member.removed';
// S63 (D12 / FR-RM05·06): kick(재가입 가능) 과 ban(영구 차단)을 구분한 모더레이션
// 이벤트. 둘 다 outbox-to-ws 가 대상 user 룸으로 fanout 하고 kickUserEverywhere 로
// 즉시 소켓을 끊는다. kicked 은 actor 소켓에 별도 undoToken 을 전달한다(브로드캐스트
// 제외 — moderation.service 가 actor 소켓에만 직접 emit).
export const MEMBER_KICKED = 'workspace.member.kicked';
export const MEMBER_BANNED = 'workspace.member.banned';
export const ROLE_CHANGED = 'workspace.role.changed';
export const OWNERSHIP_TRANSFERRED = 'workspace.ownership.transferred';
export const INVITE_CREATED = 'workspace.invite.created';
export const INVITE_REVOKED = 'workspace.invite.revoked';
export const INVITE_ACCEPTED = 'workspace.invite.accepted';
// S67 fix-forward (security MEDIUM + reviewer #5): 영구 삭제(hard delete)는 가역적
// soft revoke(INVITE_REVOKED)와 달리 행을 제거하는 파괴적 액션이라 별도 이벤트로 추적한다.
// hardDelete 트랜잭션이 행 삭제와 같은 commit 으로 outbox 에 기록한다(감사 무결성).
export const INVITE_DELETED = 'workspace.invite.deleted';

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
