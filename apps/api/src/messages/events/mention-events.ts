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
  workspaceId: string;
  channelId: string;
  messageId: string;
  actorId: string;
  snippet: string;
  createdAt: string;
  everyone: boolean;
};
