/**
 * Task-011-B mention notifications.
 *
 * One `mention.received` event is emitted per mentioned user per
 * message — fan-out happens at outbox-write time inside the same
 * transaction that persisted the message. The outbox → WS projection
 * routes to the `user:<id>` room via `targetUserId` on the envelope.
 */
export const MENTION_RECEIVED = 'mention.received';

export type MentionReceivedPayload = {
  targetUserId: string;
  // task-034-follow: Global DM messages can't mention workspace
  // members; extractMentions returns empty for null so this branch
  // never fires in practice, but the type needs to be widened so the
  // enclosing MessagesService can compile with a nullable workspaceId.
  workspaceId: string | null;
  channelId: string;
  messageId: string;
  actorId: string;
  snippet: string;
  createdAt: string;
  everyone: boolean;
  // task-047 iter0 (HIGH-046-B carry-over): @here mention 도 dispatcher
  // 측 분기 가능하도록 payload 에 포함. UI 가 @here 표시 / online-only
  // filter 적용은 후속 dispatcher 통합 (047 follow-up 이거나 별도 task).
  here: boolean;
  // S88a (FR-MN-03): 이 수신자가 `@<RoleName>` 역할 멘션에서 유래했는지 표식.
  // 명시 @user 와 역할 멘션 양쪽에 걸린 수신자는 dedup 되어 1건만 emit 되며, 그때
  // 명시 멘션이 우선이라 role 은 false 다(direct 분류와 일관). UI 분기용 · optional
  // 이라 구 dispatcher/payload 와 forward-compat.
  role?: boolean;
  // FR-MN-10 (066 / S93): 이 수신자가 키워드 알림 스캔(mention-scan 워커)에서 유래했는지
  // 표식. true 면 본문에 이 사용자의 등록 키워드가 어절 정확 일치해 알림된 것이다(@user/
  // @role 과 별개 사유). UI 가 Inbox 에서 "키워드 알림" 레이블을 분기하는 데 쓴다.
  // optional 이라 구 dispatcher/payload(키워드 아님 = undefined→false)와 forward-compat.
  keyword?: boolean;
};
