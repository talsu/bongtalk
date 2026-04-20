export const MESSAGE_CREATED = 'message.created';
export const MESSAGE_UPDATED = 'message.updated';
export const MESSAGE_DELETED = 'message.deleted';
// task-014-B: aggregate "a reply happened on this root" signal. Emitted
// alongside `message.created` whenever the created message has a
// parent. Consumers that care about the root's replyCount/avatar stack
// patch it via this explicit event; dispatcher dedupes against the
// `message.created` carrying `parentMessageId` so clients don't
// double-bump the summary.
export const MESSAGE_THREAD_REPLIED = 'message.thread.replied';

export type MessageCreatedPayload = {
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: {
    id: string;
    authorId: string;
    content: string;
    mentions: { users: string[]; channels: string[]; everyone: boolean };
    createdAt: string;
    // task-014-B: null for root, uuid for reply. Additive — existing
    // 005/011/013 dispatcher branches ignore unknown fields.
    parentMessageId: string | null;
  };
};

export type MessageThreadRepliedPayload = {
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  replierId: string;
  // Server-authoritative counts — client doesn't ±1.
  replyCount: number;
  lastRepliedAt: string;
  // Capped so the outbox payload stays small; if a root hits more than
  // this many distinct repliers, the UI's "+N" overflow covers it.
  recentReplyUserIds: string[];
  // List of recipients the dispatcher should toast. Cap N=20; root
  // author + the 19 most recent repliers. Author is always recipients[0]
  // so the dispatcher can suppress self-toasts cheaply.
  recipients: string[];
};

export type MessageUpdatedPayload = {
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: {
    id: string;
    authorId: string;
    content: string;
    mentions: { users: string[]; channels: string[]; everyone: boolean };
    editedAt: string;
  };
};

export type MessageDeletedPayload = {
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: { id: string; authorId: string; deletedAt: string };
};

/**
 * task-014-B fan-out cap. The thread.replied outbox event targets the
 * root author + the most recent N distinct repliers. N=20 balances
 * "everyone who cared about this thread gets notified" against
 * "a popular thread doesn't emit 500 events per reply". Bumping this
 * past a beta scale warrants a per-thread follower set.
 */
export const THREAD_REPLY_RECIPIENT_CAP = 20;
