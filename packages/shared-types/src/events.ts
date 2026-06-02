import { z } from 'zod';
import { MessageMentionsSchema } from './message';
import { TYPING_MAX_VISIBLE } from './constants';

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
  // S26 (FR-P16): 구독 해제. presence:sub:{socketId} Set 에서 userIds 를 SREM.
  PRESENCE_UNSUBSCRIBE: 'presence:unsubscribe',
  PRESENCE_BULK: 'presence:bulk',
  PRESENCE_ACTIVITY: 'presence:activity',
  PRESENCE_SET: 'presence:set',
  PRESENCE_UPDATE: 'presence:update',
  // S25 (FR-RT-10): 워크스페이스 룸 브로드캐스트. online/dnd/idle userId 집합을
  // 싣는다. 게이트웨이 schedulePresenceBroadcast + 웹 dispatcher 가 이 상수로
  // emit/subscribe 한다.
  //
  // ⚠️ 이벤트명은 점 표기 `presence.updated` 를 유지한다 — 콜론 표기
  // (`presence:updated`) 로의 rename 은 WS-naming 수렴(S10) 묶음으로 이관된
  // carryover 다. 본 슬라이스는 타입화(스키마+상수)만 수행하고 와이어 이름은
  // 바꾸지 않는다(라이브 클라 회귀 방지).
  WORKSPACE_PRESENCE_UPDATED: 'presence.updated',
  // 읽음 / 미읽
  READ_STATE_UPDATED: 'read_state:updated',
  UNREAD_COUNT_INCREMENT: 'unread_count:increment',
  // DM / 그룹 DM (S16 · FR-DM-16): 새 DM·그룹 DM 개설 또는 멤버 추가 시 대상
  // 참여자의 user:{userId} 룸으로 push. 클라이언트는 DM 목록 캐시를 무효화한다.
  DM_CREATED: 'dm:created',
  // 그룹 DM 멤버십 변경 (S19 · FR-DM-07/08/09): 멤버 추가/강퇴/나가기·owner 승계 시
  // 대상 참여자의 user:{userId} 룸으로 push. 클라이언트는 멤버 목록/owner 캐시를
  // 무효화한다. dm:created 선례대로 내부 recipients 는 와이어에서 제거되고 최소
  // 필드(channelId + 변경 대상 userId 등)만 노출한다(참여자 UUID 전체 비노출).
  DM_PARTICIPANT_ADDED: 'dm:participant_added',
  DM_PARTICIPANT_REMOVED: 'dm:participant_removed',
  DM_OWNER_CHANGED: 'dm:owner_changed',
  // 그룹 DM 표시 메타 변경 (S20 · FR-DM-05/06): 이름(displayName) 또는 아이콘
  // (iconUrl) 변경 시 참여자의 user:{userId} 룸으로 push. 클라이언트는 DM 헤더/
  // 사이드바의 표시명·아이콘 캐시를 무효화한다. 내부 recipients 는 와이어에서
  // 제거되고 channelId + 변경 필드(displayName?/iconUrl?)만 노출한다(H-03 선례).
  DM_GROUP_UPDATED: 'dm:group_updated',
  // 차단 해제 (S17 · FR-DM-19): 차단 해제 시 차단 해제자(blocker)의 user:{userId}
  // 룸으로 push. 클라이언트는 해당 사용자가 작성한 메시지의 마스킹을 풀기 위해
  // 현재 채널 메시지 캐시를 무효화/재로드한다.
  USER_UNBLOCKED: 'user:unblocked',
} as const;

export type WsEventName = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

const ChannelIdSchema = z.string().min(1);
const UserIdSchema = z.string().min(1);
const SeqSchema = z.number().int(); // -1 sentinel(SEQ_SENTINEL) 허용 → nonnegative 강제 안 함

/**
 * S25 (FR-P01): 프레즌스 상태 5종.
 *
 *   online    — 활성 연결 + 최근 활동(IDLE_TIMEOUT 이내)
 *   idle      — 활성 연결 + IDLE_TIMEOUT 동안 활동 없음(auto-idle)
 *   dnd       — 사용자 설정(presencePreference='dnd') 우선. activity/idle 무관 유지
 *   offline   — 활성 세션 없음(마지막 세션 끊김 후 grace 만료)
 *   invisible — 사용자가 스스로 숨김. 본인에게만 실제값, 타인에게는 offline 으로 마스킹
 *
 * 와이어 포맷은 소문자 enum 이다(서버 Prisma PresencePreference 와 별개 — preference 는
 * auto/dnd/invisible 만, runtime status 는 idle/online 까지 포함).
 */
export const PresenceStatusSchema = z.enum(['online', 'idle', 'dnd', 'offline', 'invisible']);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

/**
 * S25 (FR-P01): INVISIBLE 마스킹 단일 지점.
 *
 * 외부(타 사용자)에게 `invisible` 은 항상 `offline` 으로 보인다. 본인(isSelf=true)
 * 에게만 실제 `invisible` 값이 노출된다. 그 외 상태(online/idle/dnd/offline)는
 * 그대로 통과한다.
 *
 * presence:subscribe/bulk/update, GET /users/:id/profile, 멤버 목록 등 프레즌스를
 * 외부로 내보내는 **모든** 경로가 이 함수 하나만 거치도록 한다. 라이브러리 함수라
 * 서버(NestJS)·웹(React) 양쪽에서 동일하게 재사용된다.
 */
export function maskPresenceForViewer(status: PresenceStatus, isSelf: boolean): PresenceStatus {
  if (status === 'invisible' && !isSelf) return 'offline';
  return status;
}

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

/**
 * typing:update — 단건 snapshot(full-replace, not merge). 채널의 현재 유효
 * typer 집합을 `typingUserIds` 로 싣습니다. 0명이면 `typingUserIds:[]` 로
 * 인디케이터를 clear 합니다.
 *
 * S32 fix-forward(contract CRITICAL · 4팀 합의): 종전 선언 스키마는
 * `{channelId, userId, displayName, action}` 로 라이브 와이어(게이트웨이 emit /
 * dispatcher consume)와 어긋난 *체크인된 거짓 계약*이었습니다. 실제 와이어가
 * 쓰는 `{channelId, typingUserIds:[]}` 로 정렬하고, 필드명을 `typingUserIds` 로
 * 통일합니다(현 prod 의 점 표기 `typing.updated` alias 도 이미 `typingUserIds` 를
 * 쓰므로 alias consumer 와 충돌이 없습니다). 와이어 비대화/멤버 열거를 막는
 * TYPING_MAX_VISIBLE 상한을 스키마에 명시합니다.
 */
export const TypingUpdatePayloadSchema = z.object({
  channelId: ChannelIdSchema,
  typingUserIds: z.array(UserIdSchema).max(TYPING_MAX_VISIBLE),
});
export type TypingUpdatePayload = z.infer<typeof TypingUpdatePayloadSchema>;

/**
 * typing:batch — full snapshot(replace, not merge); 0명이면 `typingUserIds:[]`
 * 로 clear. typing:update 와 동일하게 `typingUserIds` 필드명으로 통일하고
 * (S32 fix-forward · 4팀 합의), TYPING_MAX_VISIBLE 상한을 명시합니다.
 */
export const TypingBatchPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  typingUserIds: z.array(UserIdSchema).max(TYPING_MAX_VISIBLE),
});
export type TypingBatchPayload = z.infer<typeof TypingBatchPayloadSchema>;

// ── 프레즌스 ────────────────────────────────────────────────────────────────
/**
 * presence:subscribe — C→S. 구독할 userId 목록.
 *
 * S25 fix-forward(security HIGH · DoS): userIds 크기 상한 500. 한 워크스페이스
 * 멤버 목록을 한 번에 구독하는 정상 사용을 넉넉히 덮으면서, 임의 거대 배열로
 * 게이트웨이가 사용자당 Redis read 를 폭주시키는 것을 막는다. 게이트웨이는
 * safeParse 를 **실제로** 적용해 초과/비정상 페이로드를 거부한다(타입힌트만으로는
 * 런타임 보증이 없었음).
 */
export const PresenceSubscribePayloadSchema = z.object({
  userIds: z.array(UserIdSchema).max(500),
});
export type PresenceSubscribePayload = z.infer<typeof PresenceSubscribePayloadSchema>;

/**
 * S26 (FR-P16): presence:unsubscribe — 구독 Set 에서 빼고 싶은 userId 집합.
 * subscribe 와 동일한 500 상한을 둔다(거대 배열로 게이트웨이 SREM 폭주 방지).
 */
export const PresenceUnsubscribePayloadSchema = z.object({
  userIds: z.array(UserIdSchema).max(500),
});
export type PresenceUnsubscribePayload = z.infer<typeof PresenceUnsubscribePayloadSchema>;

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

/**
 * presence.updated — 워크스페이스 룸(rooms.workspace(wsId))으로 emit (S25 ·
 * FR-RT-10). 한 워크스페이스의 현재 online/dnd/idle 사용자 집합을 싣는다.
 *
 *   onlineUserIds — 활성 세션을 가진(observable) 사용자 (idle 포함, INVISIBLE 제외)
 *   dndUserIds    — Do Not Disturb 닷 대상 (online 의 부분집합)
 *   idleUserIds   — auto-idle 닷 대상 (online 의 부분집합, dnd 와 배타)
 *
 * 종전 게이트웨이는 이 페이로드를 WS_EVENTS/Zod 미등록 raw 객체로 emit 했다.
 * S25 fix-forward(contract HIGH): 스키마+상수로 타입화한다. 와이어 이름은 점 표기
 * `presence.updated` 유지(콜론 rename 은 S10 carryover).
 */
export const WorkspacePresenceUpdatedPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  onlineUserIds: z.array(UserIdSchema),
  dndUserIds: z.array(UserIdSchema),
  idleUserIds: z.array(UserIdSchema),
});
export type WorkspacePresenceUpdatedPayload = z.infer<typeof WorkspacePresenceUpdatedPayloadSchema>;

// ── 읽음 / 미읽 ──────────────────────────────────────────────────────────────
/**
 * S11 (FR-RT-13): POST /workspaces/:id/channels/:chid/ack 요청 바디.
 * lastReadMessageId 는 클라가 화면에서 마지막으로 본 메시지 id, clientTimestamp
 * 는 클라 시계(관측용 epoch ms). 5초 debounce 는 프론트(클라) 책임이며 S11
 * 백엔드 범위 밖이다 — 서버는 매 ack 를 monotonic upsert 로 처리한다(퇴행 무시).
 */
export const AckReadRequestSchema = z.object({
  lastReadMessageId: z.string().uuid(),
  clientTimestamp: z.number().int().nonnegative().optional(),
});
export type AckReadRequest = z.infer<typeof AckReadRequestSchema>;

/**
 * S24 (FR-RS-08): POST /workspaces/:id/channels/:chid/unread 요청 바디.
 * `messageId` 는 사용자가 "여기서부터 미읽" 으로 지정한 메시지 — 서버는 그
 * **직전** 메시지로 lastReadMessageId 를 되돌린다(직전이 없으면 null = 전체 미읽).
 * S21 monotonic guard 를 의도적으로 우회하는 후진 경로(markUnread)다.
 */
export const MarkUnreadRequestSchema = z.object({
  messageId: z.string().uuid(),
});
export type MarkUnreadRequest = z.infer<typeof MarkUnreadRequestSchema>;

/**
 * S36 (FR-RS-12 / FR-TH-12): POST /messages/:id/thread/ack 요청 바디.
 * `lastReadMessageId` 는 스레드 패널에서 마지막으로 본 답글 id. 서버는 채널
 * 미읽과 동일한 monotonic (createdAt, id) 튜플 upsert 로 ThreadReadState 를
 * 전진시킨다(퇴행 ack no-op). 채널 미읽과 독립적으로 스레드 미읽만 0 으로 수렴.
 */
export const ThreadAckRequestSchema = z.object({
  lastReadMessageId: z.string().uuid(),
});
export type ThreadAckRequest = z.infer<typeof ThreadAckRequestSchema>;

/**
 * S24 (FR-RS-18): POST /workspaces/:id/read-all/undo 요청 바디. read-all 응답이
 * 발급한 `snapshotId` 로 직전 ChannelReadState 를 복원한다(후진 허용 — markUnread
 * 와 동일한 비-monotonic 경로). Redis(TTL 5분) 히트 → Redis, miss → DB 복원.
 */
export const UndoMarkAllReadRequestSchema = z.object({
  snapshotId: z.string().uuid(),
});
export type UndoMarkAllReadRequest = z.infer<typeof UndoMarkAllReadRequestSchema>;

/**
 * read_state:updated — 호출자의 user:{userId} 룸으로만 emit (FR-RS-01 멀티세션
 * 동기화). ACK 한 채널의 새 unread/mention 카운트를 함께 실어 다른 기기/탭이
 * 사이드바 배지를 즉시 갱신할 수 있게 한다. `mentionCount` 는 S21 추가분 —
 * forward-compat 위해 default(0) (구 클라/구 서버 페이로드 호환).
 */
export const ReadStateUpdatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  // S21 fix-forward (NIT-G): 채널이 속한 워크스페이스 id. dispatcher 가
  // unread-summary 쿼리 전체를 스캔하지 않고 `qk.channels.unreadSummary(workspaceId)`
  // 를 직접 patch 할 수 있게 한다. ackRead 가 채널 조회로 이미 보유한 값이라
  // 추가 round-trip 없음. forward-compat 위해 optional — 구 서버 페이로드는
  // workspaceId 누락이어도 dispatcher 가 전체 스캔으로 폴백한다.
  workspaceId: z.string().nullable().optional(),
  lastReadMessageId: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
  mentionCount: z.number().int().nonnegative().default(0),
});
export type ReadStateUpdatedPayload = z.infer<typeof ReadStateUpdatedPayloadSchema>;

/** unread_count:increment — user:{userId} 룸으로만 emit. */
export const UnreadCountIncrementPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  delta: z.number().int(),
});
export type UnreadCountIncrementPayload = z.infer<typeof UnreadCountIncrementPayloadSchema>;

/**
 * dm:created — 각 참여자의 user:{userId} 룸으로 emit (S16 · FR-DM-16).
 * `isGroup` 으로 1:1 / 그룹 DM 을 구분하고, `participantIds` 로 멤버 set 을 싣는다.
 *
 * S16 (HIGH fix-forward): 내부 라우팅용 `recipients` 필드는 **와이어 페이로드에서
 * 제거**한다. recipients 는 outbox payload 에만 남아 구독자가 어느 user 룸으로
 * fanout 할지 결정하는 서버 전용 정보이며, 클라이언트로 노출되면 참여자 UUID
 * 전체가 새므로 emit 직전에 제거한다(id/type/channelId/isGroup/participantIds 만).
 */
export const DmCreatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  isGroup: z.boolean(),
  participantIds: z.array(UserIdSchema),
});
export type DmCreatedPayload = z.infer<typeof DmCreatedPayloadSchema>;

/**
 * dm:participant_added — 그룹 DM 멤버 추가 시 대상 채널의 기존+신규 참여자
 * user:{userId} 룸으로 emit (S19 · FR-DM-07). `addedUserIds` 는 이번에 추가된
 * 멤버 set. 내부 라우팅용 recipients 는 와이어에서 제거된다(H-03 선례). 클라이언트는
 * 멤버 목록 캐시를 무효화한다.
 */
export const DmParticipantAddedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  addedUserIds: z.array(UserIdSchema),
});
export type DmParticipantAddedPayload = z.infer<typeof DmParticipantAddedPayloadSchema>;

/**
 * dm:participant_removed — 그룹 DM 강퇴/나가기 시 대상 채널의 참여자
 * user:{userId} 룸으로 emit (S19 · FR-DM-08/09). `removedUserId` 는 제거된 멤버,
 * `reason` 은 강퇴('kicked') / 본인 나가기('left'). 내부 recipients 는 와이어에서
 * 제거된다(H-03). 클라이언트는 멤버 목록 캐시를 무효화하고, 본인이 removedUserId
 * 이면 해당 DM 을 목록에서 제거한다.
 */
export const DmParticipantRemovedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  removedUserId: UserIdSchema,
  reason: z.enum(['kicked', 'left']),
});
export type DmParticipantRemovedPayload = z.infer<typeof DmParticipantRemovedPayloadSchema>;

/**
 * dm:owner_changed — 그룹 DM owner 승계 시 참여자 user:{userId} 룸으로 emit
 * (S19 · FR-DM-09). owner 가 나갈 때 잔여 멤버 중 joinedAt 최古로 자동 승계되며
 * `ownerId` 는 새 owner userId. 내부 recipients 는 와이어에서 제거된다(H-03).
 */
export const DmOwnerChangedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  ownerId: UserIdSchema,
});
export type DmOwnerChangedPayload = z.infer<typeof DmOwnerChangedPayloadSchema>;

/**
 * dm:group_updated — 그룹 DM 표시 메타(이름/아이콘) 변경 시 참여자 user:{userId}
 * 룸으로 emit (S20 · FR-DM-05/06). `displayName` 은 새 표시명(빈 문자열로 초기화
 * 불가 — 변경 시에만 실린다), `iconUrl` 은 새 아이콘 키/URL(삭제 시 null). 둘 다
 * optional/nullable 이라 한 이벤트가 이름·아이콘 중 변경분만 싣는다. 내부 라우팅용
 * recipients 는 와이어에서 제거된다(H-03 선례). 클라이언트는 DM 헤더/사이드바
 * 표시명·아이콘 캐시를 무효화한다.
 */
export const DmGroupUpdatedPayloadSchema = z.object({
  channelId: ChannelIdSchema,
  displayName: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
});
export type DmGroupUpdatedPayload = z.infer<typeof DmGroupUpdatedPayloadSchema>;

/**
 * user:unblocked — 차단 해제자(blocker)의 user:{userId} 룸으로 emit
 * (S17 · FR-DM-19). `unblockedUserId` 는 차단이 풀린 상대 userId. 클라이언트는
 * 이 id 가 작성한 메시지의 마스킹(`[차단된 사용자의 메시지]`)을 풀기 위해 현재
 * 채널의 메시지 캐시를 무효화/재로드한다. 차단을 *건* 이벤트는 별도로 emit 하지
 * 않는다(차단 시점 마스킹은 다음 list 응답에서 자연히 반영되며, 즉시 마스킹이
 * 필요하면 클라이언트가 로컬에서 처리). 비노출 정책상 차단당한 쪽에는 보내지
 * 않는다 — blocker 본인 룸으로만 fanout 한다.
 */
export const UserUnblockedPayloadSchema = z.object({
  unblockedUserId: UserIdSchema,
});
export type UserUnblockedPayload = z.infer<typeof UserUnblockedPayloadSchema>;

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
  [WS_EVENTS.PRESENCE_UNSUBSCRIBE]: PresenceUnsubscribePayloadSchema,
  [WS_EVENTS.PRESENCE_BULK]: PresenceBulkPayloadSchema,
  [WS_EVENTS.PRESENCE_ACTIVITY]: PresenceActivityPayloadSchema,
  [WS_EVENTS.PRESENCE_SET]: PresenceSetPayloadSchema,
  [WS_EVENTS.PRESENCE_UPDATE]: PresenceUpdatePayloadSchema,
  [WS_EVENTS.WORKSPACE_PRESENCE_UPDATED]: WorkspacePresenceUpdatedPayloadSchema,
  [WS_EVENTS.READ_STATE_UPDATED]: ReadStateUpdatedPayloadSchema,
  [WS_EVENTS.UNREAD_COUNT_INCREMENT]: UnreadCountIncrementPayloadSchema,
  [WS_EVENTS.DM_CREATED]: DmCreatedPayloadSchema,
  [WS_EVENTS.DM_PARTICIPANT_ADDED]: DmParticipantAddedPayloadSchema,
  [WS_EVENTS.DM_PARTICIPANT_REMOVED]: DmParticipantRemovedPayloadSchema,
  [WS_EVENTS.DM_OWNER_CHANGED]: DmOwnerChangedPayloadSchema,
  [WS_EVENTS.DM_GROUP_UPDATED]: DmGroupUpdatedPayloadSchema,
  [WS_EVENTS.USER_UNBLOCKED]: UserUnblockedPayloadSchema,
} as const satisfies Record<WsEventName, z.ZodTypeAny>;
