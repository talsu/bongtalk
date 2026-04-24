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
};
