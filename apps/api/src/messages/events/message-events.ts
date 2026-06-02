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

// S35 (FR-TH-06): 스레드→채널 broadcast. 답글을 'Also send to #channel' 체크와
// 함께 전송하면, send tx 안에서 별도의 SYSTEM_THREAD_BROADCAST 행을 채널
// 타임라인에 동시 게시하고 이 이벤트를 emit 한다. dot 컨벤션(message.thread.*)을
// 유지해 outbox-to-ws subscriber 의 `message.**` 와일드카드가 자동으로 채널
// 룸 fanout 한다(별도 라우팅 코드 불필요). 클라이언트 dispatcher 는 broadcast
// MessageDto 를 채널 타임라인 캐시에 삽입한다(thread.replied 와 달리 채널 행
// 자체를 추가). PRD 의 `thread:broadcast { channelId, broadcastMessage,
// parentMessageId, parentExcerpt }` 콜론 와이어명으로의 수렴은 S10 WS-naming
// 번들 carryover — 본 슬라이스는 dot 일관 유지.
export const MESSAGE_THREAD_BROADCAST = 'message.thread.broadcast';

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
    // S37 (FR-MSG-17): 평문 정본 e2e 전파. 디스패처가 이 message 를 캐시에
    // MessageDto 로 삽입하므로, "메시지 복사" 가 마크다운(content)이 아니라
    // 평문을 복사하려면 라이브 수신측 캐시에도 contentPlain 이 있어야 한다.
    // Additive — 구 디스패처는 무시.
    contentPlain: string;
    // S04 (FR-MSG-19): 메시지 타입. SYSTEM_* 만 명시(DEFAULT 는 생략 가능 →
    // 디스패처가 누락 시 'DEFAULT' 로 폴백). 클라이언트 캐시가 시스템 행
    // 렌더 + grouped=false 분기에 사용. Additive — 구 디스패처는 무시.
    type?: string;
    // task-047 iter0 (HIGH-046-B): @here flag e2e propagation.
    // S21 fix-forward (MAJOR-D): @channel flag e2e propagation — 디스패처
    // isMention 이 @channel 을 인식해 live 배지가 reload 와 일치하도록.
    mentions: {
      users: string[];
      channels: string[];
      everyone: boolean;
      here: boolean;
      channel: boolean;
    };
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

// S35 (FR-TH-06): broadcast 채널 게시 payload. broadcast 행(SYSTEM_THREAD_
// BROADCAST)의 채널 타임라인 삽입에 필요한 필드를 담는다. message.created 와
// 동일한 message 서브셋 + parentExcerpt(루트 50자) + isBroadcast=true. 클라
// dispatcher 는 이 message 를 채널 캐시에 삽입하고(parentMessageId 가 있어도
// isBroadcast 면 채널 행으로 취급), parentExcerpt 를 레이블과 함께 렌더한다.
export type MessageThreadBroadcastPayload = {
  workspaceId: string | null;
  channelId: string;
  actorId: string;
  // broadcast 행이 가리키는 스레드 루트. 클릭 시 스레드 열기 + dedupe 키.
  parentMessageId: string;
  // 루트 메시지 본문 excerpt(50자, 초과 시 끝에 "…"). null 불가(항상 채운다).
  parentExcerpt: string;
  message: {
    id: string;
    authorId: string;
    content: string;
    contentRaw: string;
    contentAst: unknown;
    type: string;
    mentions: {
      users: string[];
      channels: string[];
      everyone: boolean;
      here: boolean;
      channel: boolean;
    };
    createdAt: string;
    parentMessageId: string | null;
    // S35: 채널 행이 broadcast 임을 클라이언트가 인식하는 키.
    isBroadcast: boolean;
  };
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
    // S37 (FR-MSG-17): 편집 시 재계산된 평문 정본 e2e 전파. 라이브 수신측
    // 캐시가 편집된 본문의 평문을 "메시지 복사" 정본으로 쓰도록 실어보낸다.
    // Additive — 구 디스패처는 무시.
    contentPlain: string;
    // task-047 iter0 (HIGH-046-B): @here flag e2e propagation.
    // S21 fix-forward (MAJOR-D): @channel flag e2e propagation.
    mentions: {
      users: string[];
      channels: string[];
      everyone: boolean;
      here: boolean;
      channel: boolean;
    };
    editedAt: string;
    // S05 verify (FR-MSG-07): (수정됨) 뱃지의 라이브 전파. 디스패처는 캐시 행
    // 위에 이 부분 DTO 를 verbatim merge 하므로, `edited` 를 싣지 않으면 편집
    // 전 캐시(edited:false)를 가진 다른 클라이언트는 REST refetch 전까지 뱃지를
    // 못 본다. 편집 성공 = 항상 edited:true. Additive — 구 디스패처는 무시.
    edited: boolean;
    // S05 (FR-MSG-06): 편집 후 새 version. 라이브 수신측 캐시가 낙관적 잠금
    // 기준(MessageDto.version)을 갱신하도록 실어보낸다. Additive — 구
    // 디스패처는 무시.
    version: number;
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
