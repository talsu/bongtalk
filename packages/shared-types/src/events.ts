import { z } from 'zod';
import { MessageMentionsSchema } from './message';

/**
 * ADR-12 · WS 이벤트 카탈로그 단일 정의.
 *
 * 모든 WS 이벤트명과 페이로드 스키마는 본 파일에서만 정의합니다. D01 · D16 ·
 * D17 은 이 파일만 import 하여 참조하며 중복 정의하지 않습니다.
 *
 * FR-RC23: S→C 메시지 이벤트는 반드시 과거분사형
 * message:created / message:updated / message:deleted 를 사용합니다.
 * 현재형 message:create / message:update / message:delete 표기는 폐기됩니다.
 */
export const WS_EVENTS = {
  // 연결 / 룸
  CONNECTION_READY: 'connection:ready',
  CHANNEL_JOIN: 'channel:join',
  CHANNEL_JOINED: 'channel:joined',
  CHANNEL_LEAVE: 'channel:leave',
  CHANNEL_SYNCED: 'channel:synced',
  CHANNEL_ERROR: 'channel:error',
  // 메시지 (S→C, 과거분사형 — FR-RC23)
  MESSAGE_CREATED: 'message:created',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  // 타이핑
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  TYPING_UPDATE: 'typing:update',
  TYPING_BATCH: 'typing:batch',
  // 프레즌스
  PRESENCE_SUBSCRIBE: 'presence:subscribe',
  PRESENCE_BULK: 'presence:bulk',
  PRESENCE_ACTIVITY: 'presence:activity',
  PRESENCE_SET: 'presence:set',
  PRESENCE_UPDATE: 'presence:update',
  // 읽음 / 미읽
  READ_STATE_UPDATED: 'read_state:updated',
  UNREAD_COUNT_INCREMENT: 'unread_count:increment',
} as const;

export type WsEventName = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

const ChannelIdSchema = z.string().min(1);
const UserIdSchema = z.string().min(1);
const SeqSchema = z.number().int(); // -1 sentinel(SEQ_SENTINEL) 허용 → nonnegative 강제 안 함

export const PresenceStatusSchema = z.enum(['online', 'idle', 'dnd', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

// ── 연결 / 룸 ──────────────────────────────────────────────────────────────
export const ConnectionReadyPayloadSchema = z.object({
  userId: UserIdSchema,
  sessionId: z.string().min(1),
});
export type ConnectionReadyPayload = z.infer<typeof ConnectionReadyPayloadSchema>;

export const ChannelJoinPayloadSchema = z.object({ channelId: ChannelIdSchema });
export type ChannelJoinPayload = z.infer<typeof ChannelJoinPayloadSchema>;

export const ChannelJoinedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  /** join 시점 채널 seq 스냅샷(Redis seq:{channelId} 현재값). */
  seq: SeqSchema,
  // S10 fix-forward (MAJOR #2): connect 직후 채널별 seq baseline 을 클라에
  // 내려 SeqTracker.setBaseline 을 채우는 것이 이 이벤트의 1차 용도입니다.
  // lastMessageId / unreadCount / lastReadMessageId 는 read-state·around-reload
  // 보조용 *선언적* 필드인데, 현재 어떤 클라 dispatcher 도 이 이벤트에서
  // 소비하지 않습니다(unread 레일·readStateStore 는 별도 경로). 연결당 채널
  // 50개에 대한 per-channel unread 서브쿼리 부하를 피하기 위해, baseline-only
  // 경량 emit 이 이 셋을 생략할 수 있도록 optional 로 둡니다(additive·무회귀).
  // 후속 슬라이스에서 채워질 때까지 안전하게 누락 허용.
  /** Channel.lastMessageId — 서버 최신 메시지 id 참조값. */
  lastMessageId: z.string().nullable().optional(),
  unreadCount: z.number().int().nonnegative().optional(),
  lastReadMessageId: z.string().nullable().optional(),
});
export type ChannelJoinedPayload = z.infer<typeof ChannelJoinedPayloadSchema>;

export const ChannelLeavePayloadSchema = z.object({ channelId: ChannelIdSchema });
export type ChannelLeavePayload = z.infer<typeof ChannelLeavePayloadSchema>;

export const ChannelSyncedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  fetchedCount: z.number().int().nonnegative(),
  oldestFetchedId: z.string().nullable(),
  /** GAP_FETCH_MAX_PAGES / PENDING_EVENTS_MAX 초과로 일부 누락 시 true. */
  truncated: z.boolean().optional(),
});
export type ChannelSyncedPayload = z.infer<typeof ChannelSyncedPayloadSchema>;

export const ChannelErrorPayloadSchema = z.object({
  code: z.enum(['PERMISSION_DENIED', 'JOIN_LIMIT_EXCEEDED']),
  channelId: ChannelIdSchema,
});
export type ChannelErrorPayload = z.infer<typeof ChannelErrorPayloadSchema>;

// ── 메시지 ──────────────────────────────────────────────────────────────────
/**
 * message:created — authorId 필드를 사용하며 senderId 는 사용하지 않습니다
 * (D17 회귀 spec).
 */
export const MessageCreatedPayloadSchema = z.object({
  seq: SeqSchema,
  message: z.object({
    id: z.string().min(1),
    channelId: ChannelIdSchema,
    authorId: z.string().nullable(),
    authorName: z.string(),
    authorAvatarUrl: z.string().nullable(),
    content: z.string().nullable(),
    createdAt: z.string().datetime(),
    editedAt: z.string().datetime().nullable(),
  }),
});
export type MessageCreatedPayload = z.infer<typeof MessageCreatedPayloadSchema>;

/**
 * message:updated — D01/ADR-12 정합 (forward-looking S00 계약).
 * contentRaw/contentPlain/contentAst/version/editedAt/mentions 를 포함합니다.
 *
 * ⚠️ S02 NOTE (HIGH-S02-1): 이 평탄(flat) 스키마는 아직 라이브 와이어
 * 포맷이 아닙니다. 현재 런타임은 outbox→ws 경로로 `message.updated`
 * (점 표기) 이벤트를 중첩(`{ message: { id, content, contentRaw,
 * contentAst, mentions, editedAt } }`) 페이로드로 내보냅니다 — 내부
 * 타입은 apps/api `messages/events/message-events.ts` 의
 * MessageUpdatedPayload 입니다. 본 스키마(`message:updated`, 콜론 표기)는
 * WS_EVENT_PAYLOAD_SCHEMAS 의 선언적 목표 계약일 뿐 게이트웨이/클라이언트
 * 런타임 검증에 연결돼 있지 않습니다(events.spec 단독 참조). S02 에서는
 * 중첩 페이로드에 contentRaw/contentAst 를 추가해 라이브 렌더가 AST 경로를
 * 타도록 했고(렌더 회귀 해소), 평탄 스키마로의 통일(messageId/version
 * 평탄화)은 후속 슬라이스로 이관합니다. follow-up(task): 두 계약 합치기.
 */
export const MessageUpdatedPayloadSchema = z.object({
  seq: SeqSchema,
  messageId: z.string().min(1),
  channelId: ChannelIdSchema,
  contentRaw: z.string(),
  contentPlain: z.string(),
  // contentAst 는 파싱된 rich_text AST. 구조는 mrkdwn AST 노드(D16)이지만
  // 게이트웨이 페이로드 검증에서는 존재 여부만 강제하고 형태는 서버 파서가
  // 보장합니다. z.unknown() 은 키 누락을 허용하므로 명시적 required 처리.
  contentAst: z.custom<unknown>((v) => v !== undefined, { message: 'contentAst is required' }),
  version: z.number().int().nonnegative(),
  editedAt: z.string().datetime().nullable(),
  mentions: MessageMentionsSchema,
});
export type MessageUpdatedPayload = z.infer<typeof MessageUpdatedPayloadSchema>;

export const MessageDeletedPayloadSchema = z.object({
  seq: SeqSchema,
  messageId: z.string().min(1),
  channelId: ChannelIdSchema,
  deletedAt: z.string().datetime(),
});
export type MessageDeletedPayload = z.infer<typeof MessageDeletedPayloadSchema>;

// ── 타이핑 ──────────────────────────────────────────────────────────────────
export const TypingStartPayloadSchema = z.object({ channelId: ChannelIdSchema });
export type TypingStartPayload = z.infer<typeof TypingStartPayloadSchema>;

export const TypingStopPayloadSchema = z.object({ channelId: ChannelIdSchema });
export type TypingStopPayload = z.infer<typeof TypingStopPayloadSchema>;

export const TypingUpdatePayloadSchema = z.object({
  channelId: ChannelIdSchema,
  userId: UserIdSchema,
  displayName: z.string(),
  action: z.enum(['start', 'stop']),
});
export type TypingUpdatePayload = z.infer<typeof TypingUpdatePayloadSchema>;

/** full snapshot(replace, not merge); 0명이면 userIds:[] clear. */
export const TypingBatchPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  userIds: z.array(UserIdSchema),
});
export type TypingBatchPayload = z.infer<typeof TypingBatchPayloadSchema>;

// ── 프레즌스 ────────────────────────────────────────────────────────────────
export const PresenceSubscribePayloadSchema = z.object({
  userIds: z.array(UserIdSchema),
});
export type PresenceSubscribePayload = z.infer<typeof PresenceSubscribePayloadSchema>;

export const PresenceEntrySchema = z.object({
  userId: UserIdSchema,
  status: PresenceStatusSchema,
  updatedAt: z.string().datetime(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const PresenceBulkPayloadSchema = z.object({
  presences: z.array(PresenceEntrySchema),
});
export type PresenceBulkPayload = z.infer<typeof PresenceBulkPayloadSchema>;

export const PresenceActivityPayloadSchema = z.object({
  channelId: ChannelIdSchema.optional(),
});
export type PresenceActivityPayload = z.infer<typeof PresenceActivityPayloadSchema>;

export const PresenceSetPayloadSchema = z.object({ status: PresenceStatusSchema });
export type PresenceSetPayload = z.infer<typeof PresenceSetPayloadSchema>;

/** presence:update — user:{userId} 룸으로만 emit. */
export const PresenceUpdatePayloadSchema = PresenceEntrySchema;
export type PresenceUpdatePayload = z.infer<typeof PresenceUpdatePayloadSchema>;

// ── 읽음 / 미읽 ──────────────────────────────────────────────────────────────
/** read_state:updated — user:{userId} 룸으로만 emit. */
export const ReadStateUpdatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  lastReadMessageId: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type ReadStateUpdatedPayload = z.infer<typeof ReadStateUpdatedPayloadSchema>;

/** unread_count:increment — user:{userId} 룸으로만 emit. */
export const UnreadCountIncrementPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  delta: z.number().int(),
});
export type UnreadCountIncrementPayload = z.infer<typeof UnreadCountIncrementPayloadSchema>;

/**
 * 이벤트명 → 페이로드 스키마 매핑. 게이트웨이/클라이언트가 런타임 검증에
 * 사용합니다. (이름 단일성 + 페이로드 단일성을 한 곳에서 강제)
 */
export const WS_EVENT_PAYLOAD_SCHEMAS = {
  [WS_EVENTS.CONNECTION_READY]: ConnectionReadyPayloadSchema,
  [WS_EVENTS.CHANNEL_JOIN]: ChannelJoinPayloadSchema,
  [WS_EVENTS.CHANNEL_JOINED]: ChannelJoinedPayloadSchema,
  [WS_EVENTS.CHANNEL_LEAVE]: ChannelLeavePayloadSchema,
  [WS_EVENTS.CHANNEL_SYNCED]: ChannelSyncedPayloadSchema,
  [WS_EVENTS.CHANNEL_ERROR]: ChannelErrorPayloadSchema,
  [WS_EVENTS.MESSAGE_CREATED]: MessageCreatedPayloadSchema,
  [WS_EVENTS.MESSAGE_UPDATED]: MessageUpdatedPayloadSchema,
  [WS_EVENTS.MESSAGE_DELETED]: MessageDeletedPayloadSchema,
  [WS_EVENTS.TYPING_START]: TypingStartPayloadSchema,
  [WS_EVENTS.TYPING_STOP]: TypingStopPayloadSchema,
  [WS_EVENTS.TYPING_UPDATE]: TypingUpdatePayloadSchema,
  [WS_EVENTS.TYPING_BATCH]: TypingBatchPayloadSchema,
  [WS_EVENTS.PRESENCE_SUBSCRIBE]: PresenceSubscribePayloadSchema,
  [WS_EVENTS.PRESENCE_BULK]: PresenceBulkPayloadSchema,
  [WS_EVENTS.PRESENCE_ACTIVITY]: PresenceActivityPayloadSchema,
  [WS_EVENTS.PRESENCE_SET]: PresenceSetPayloadSchema,
  [WS_EVENTS.PRESENCE_UPDATE]: PresenceUpdatePayloadSchema,
  [WS_EVENTS.READ_STATE_UPDATED]: ReadStateUpdatedPayloadSchema,
  [WS_EVENTS.UNREAD_COUNT_INCREMENT]: UnreadCountIncrementPayloadSchema,
} as const satisfies Record<WsEventName, z.ZodTypeAny>;
