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
  // null for Global DM channels (Channel.workspaceId IS NULL). The
  // outbox-to-ws subscriber routes message events by channel room
  // first and only falls back to the workspace room on
  // membership/workspace events, so a null here is benign — consumers
  // already guard on falsy workspaceId.
  workspaceId: string | null;
  channelId: string;
  actorId: string;
  // S03 (FR-MSG-04): clientNonce echo. The sending tab matches this against
  // its optimistic (pending) row's nonce to swap it for the confirmed
  // message; other tabs / devices ignore it and dedupe by messageId (FR-RT-24).
  // null/undefined when the client sent no nonce (e.g. system messages).
  nonce?: string | null;
  message: {
    id: string;
    authorId: string;
    content: string;
    // S02 (HIGH-S02-1): rich content e2e propagation. The client
    // dispatcher inserts `message` directly into the message-list cache
    // as a MessageDto, so the WS payload must carry the same rich fields
    // the REST projection does — otherwise the new renderAst path silently
    // degrades to the regex fallback for live messages until a REST
    // refetch. Additive: legacy dispatcher branches that read only
    // {id, authorId, content, …} ignore these. contentAst is the parsed
    // rich_text AST (RichTextRoot); JSON-serializable, so typed `unknown`
    // here to keep this events module free of the shared-types import.
    contentRaw: string;
    contentAst: unknown;
    // S04 (FR-MSG-19): 메시지 타입. SYSTEM_* 만 명시(DEFAULT 는 생략 가능 →
    // 디스패처가 누락 시 'DEFAULT' 로 폴백). 클라이언트 캐시가 시스템 행
    // 렌더 + grouped=false 분기에 사용. Additive — 구 디스패처는 무시.
    type?: string;
    // task-047 iter0 (HIGH-046-B): @here flag e2e propagation.
    mentions: { users: string[]; channels: string[]; everyone: boolean; here: boolean };
    createdAt: string;
    // task-014-B: null for root, uuid for reply. Additive — existing
    // 005/011/013 dispatcher branches ignore unknown fields.
    parentMessageId: string | null;
  };
};

export type MessageThreadRepliedPayload = {
  workspaceId: string | null;
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
  workspaceId: string | null;
  channelId: string;
  actorId: string;
  message: {
    id: string;
    authorId: string;
    content: string;
    // S02 (HIGH-S02-1): rich content e2e propagation on edit. Same
    // rationale as MessageCreatedPayload — the client replaces the cached
    // MessageDto with `message` verbatim, so a live edit must carry the
    // re-parsed AST or the bubble silently reverts to the regex fallback
    // until the next REST refetch. contentAst is the parsed RichTextRoot.
    contentRaw: string;
    contentAst: unknown;
    // task-047 iter0 (HIGH-046-B): @here flag e2e propagation.
    mentions: { users: string[]; channels: string[]; everyone: boolean; here: boolean };
    editedAt: string;
  };
};

export type MessageDeletedPayload = {
  workspaceId: string | null;
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

// task-044-iter2: pinned message toggled. pin/unpin 둘 다 같은 이벤트
// 종류로 처리하되 pinnedAt 가 null 인지로 구분합니다. 채널 룸 fanout —
// 워크스페이스 룸 broadcast 는 의도적으로 X (pin 정보는 채널 컨텍스트).
export const MESSAGE_PIN_TOGGLED = 'message.pin.toggled';

export type MessagePinToggledPayload = {
  workspaceId: string | null;
  channelId: string;
  actorId: string;
  messageId: string;
  // pinnedAt = null → unpinned. 둘 다 ISO string 또는 null.
  pinnedAt: string | null;
  pinnedBy: string | null;
};
