import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WS_EVENTS,
  WS_EVENT_PAYLOAD_SCHEMAS,
  MessageCreatedPayloadSchema,
  MessageUpdatedPayloadSchema,
  MessageDeletedPayloadSchema,
  ReadStateUpdatedPayloadSchema,
  PresenceUpdatePayloadSchema,
  PresenceSubscribePayloadSchema,
  PresenceUnsubscribePayloadSchema,
  WorkspacePresenceUpdatedPayloadSchema,
  TypingUpdatePayloadSchema,
  TypingBatchPayloadSchema,
  ChannelJoinedPayloadSchema,
  maskPresenceForViewer,
  ThreadAckRequestSchema,
  ThreadLockChangedPayloadSchema,
  ConnectionReadyPayloadSchema,
  UnreadCountIncrementPayloadSchema,
  MentionNewPayloadSchema,
} from './events';
import { TYPING_MAX_VISIBLE } from './constants';
import { extractMentionUserIds } from './mrkdwn';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ISO = '2025-01-01T00:00:00.000Z';

describe('WS_EVENTS catalog (ADR-12 / FR-RC23)', () => {
  it('uses past-participle message event names (not present tense)', () => {
    expect(WS_EVENTS.MESSAGE_CREATED).toBe('message:created');
    expect(WS_EVENTS.MESSAGE_UPDATED).toBe('message:updated');
    expect(WS_EVENTS.MESSAGE_DELETED).toBe('message:deleted');
    const values = Object.values(WS_EVENTS);
    expect(values).not.toContain('message:create');
    expect(values).not.toContain('message:update');
    expect(values).not.toContain('message:delete');
  });

  it('defines the core realtime events', () => {
    expect(WS_EVENTS.READ_STATE_UPDATED).toBe('read_state:updated');
    expect(WS_EVENTS.PRESENCE_UPDATE).toBe('presence:update');
    expect(WS_EVENTS.TYPING_START).toBe('typing:start');
    expect(WS_EVENTS.TYPING_STOP).toBe('typing:stop');
    expect(WS_EVENTS.TYPING_UPDATE).toBe('typing:update');
  });

  // S17 (FR-DM-19): 차단 해제 갱신 이벤트. blocker 본인 룸으로만 fanout 하며
  // unblockedUserId 만 싣는다(비노출 — 차단당한 쪽엔 emit 안 함).
  it('defines user:unblocked with an unblockedUserId payload (S17 · FR-DM-19)', () => {
    expect(WS_EVENTS.USER_UNBLOCKED).toBe('user:unblocked');
    const p = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.USER_UNBLOCKED].parse({
      unblockedUserId: 'u1',
    });
    expect((p as { unblockedUserId: string }).unblockedUserId).toBe('u1');
  });

  // S40 (FR-RE09): 반응 일괄 삭제 이벤트. 채널 룸 전체로 fanout 하며
  // messageId + channelId 만 싣는다(전체 제거라 집계 불필요).
  it('defines reaction:cleared with a messageId + channelId payload (S40 · FR-RE09)', () => {
    expect(WS_EVENTS.REACTION_CLEARED).toBe('reaction:cleared');
    const p = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.REACTION_CLEARED].parse({
      messageId: 'm1',
      channelId: 'c1',
    });
    expect(p).toEqual({ messageId: 'm1', channelId: 'c1' });
  });

  // S58 (FR-AM-25): 첨부 후처리 완료 이벤트. 채널 룸 fanout 이라 channelId 가 식별자이며
  // 종착 status 는 READY|BLOCKED 만 허용한다(PENDING/PROCESSING 은 전환 대상이라 불가).
  it('defines attachment:processing_done with a channel-scoped payload (S58 · FR-AM-25)', () => {
    expect(WS_EVENTS.ATTACHMENT_PROCESSING_DONE).toBe('attachment:processing_done');
    const schema = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.ATTACHMENT_PROCESSING_DONE];
    const p = schema.parse({
      channelId: 'c1',
      messageId: 'm1',
      attachmentId: 'a1',
      status: 'READY',
      thumbnailKey: 'thumb/a1',
    });
    expect(p).toEqual({
      channelId: 'c1',
      messageId: 'm1',
      attachmentId: 'a1',
      status: 'READY',
      thumbnailKey: 'thumb/a1',
    });
    // thumbnailKey 는 null 허용(차단/미생성), status 는 PENDING/PROCESSING 거부.
    expect(() =>
      schema.parse({
        channelId: 'c1',
        messageId: 'm1',
        attachmentId: 'a1',
        status: 'BLOCKED',
        thumbnailKey: null,
      }),
    ).not.toThrow();
    expect(() =>
      schema.parse({
        channelId: 'c1',
        messageId: 'm1',
        attachmentId: 'a1',
        status: 'PROCESSING',
        thumbnailKey: null,
      }),
    ).toThrow();
  });

  it('every event name has a payload schema and names are unique', () => {
    const names = Object.values(WS_EVENTS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(WS_EVENT_PAYLOAD_SCHEMAS[name]).toBeDefined();
    }
  });
});

describe('S70 application + member_left payloads', () => {
  it('ws:application_received requires applicant identity', () => {
    const p = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.APPLICATION_RECEIVED].parse({
      workspaceId: 'w1',
      applicationId: 'a1',
      applicantId: 'u1',
      applicantName: 'alice',
    });
    expect(p).toMatchObject({ applicationId: 'a1', applicantId: 'u1' });
    expect(() =>
      WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.APPLICATION_RECEIVED].parse({
        workspaceId: 'w1',
        applicationId: 'a1',
      }),
    ).toThrow();
  });

  it('ws:application_reviewed accepts lowercase wire status + optional reviewNote', () => {
    const approved = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.APPLICATION_REVIEWED].parse({
      workspaceId: 'w1',
      applicationId: 'a1',
      status: 'approved',
    });
    expect(approved).toMatchObject({ status: 'approved' });
    const rejected = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.APPLICATION_REVIEWED].parse({
      workspaceId: 'w1',
      applicationId: 'a1',
      status: 'rejected',
      reviewNote: 'not a fit',
    });
    expect(rejected).toMatchObject({ status: 'rejected', reviewNote: 'not a fit' });
    // PENDING/WITHDRAWN 같은 비-wire 상태는 거부(외부 노출은 3종만).
    expect(() =>
      WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.APPLICATION_REVIEWED].parse({
        workspaceId: 'w1',
        applicationId: 'a1',
        status: 'PENDING',
      }),
    ).toThrow();
  });

  it('ws:member_left enumerates temp_expired reason', () => {
    const p = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.MEMBER_LEFT].parse({
      workspaceId: 'w1',
      userId: 'u1',
      reason: 'temp_expired',
    });
    expect(p).toMatchObject({ reason: 'temp_expired' });
    expect(() =>
      WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.MEMBER_LEFT].parse({
        workspaceId: 'w1',
        userId: 'u1',
        reason: 'banned',
      }),
    ).toThrow();
  });

  // S72 (D13 · FR-W15): 워크스페이스 삭제/복원 wire 이벤트.
  it('ws:workspace_deleted carries workspaceId + actorId + ISO deleteAt', () => {
    const p = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.WORKSPACE_DELETED].parse({
      workspaceId: 'w1',
      actorId: 'u1',
      deleteAt: '2025-01-31T00:00:00.000Z',
    });
    expect(p).toMatchObject({ workspaceId: 'w1', actorId: 'u1' });
    // deleteAt must be an ISO datetime — a bare date is rejected.
    expect(() =>
      WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.WORKSPACE_DELETED].parse({
        workspaceId: 'w1',
        actorId: 'u1',
        deleteAt: '2025-01-31',
      }),
    ).toThrow();
  });

  it('ws:workspace_restored carries workspaceId + actorId', () => {
    const p = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.WORKSPACE_RESTORED].parse({
      workspaceId: 'w1',
      actorId: 'u1',
    });
    expect(p).toMatchObject({ workspaceId: 'w1', actorId: 'u1' });
    expect(() =>
      WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.WORKSPACE_RESTORED].parse({ workspaceId: 'w1' }),
    ).toThrow();
  });

  // S74 (D14 · FR-PS-06 · contract MEDIUM): workspace_profile.updated wire 스키마.
  it('workspace_profile.updated carries workspaceId/userId + nullable ws nickname/avatar', () => {
    expect(WS_EVENTS.WORKSPACE_PROFILE_UPDATED).toBe('workspace_profile.updated');
    const schema = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.WORKSPACE_PROFILE_UPDATED];
    const p = schema.parse({
      workspaceId: 'w1',
      userId: 'u1',
      wsNickname: 'Captain',
      wsAvatarUrl: null,
    });
    expect(p).toMatchObject({ workspaceId: 'w1', userId: 'u1', wsNickname: 'Captain' });
    // null 닉네임/아바타(전역 폴백)도 허용.
    expect(
      schema.parse({ workspaceId: 'w1', userId: 'u1', wsNickname: null, wsAvatarUrl: null }),
    ).toBeTruthy();
    // userId 누락 → reject.
    expect(() =>
      schema.parse({ workspaceId: 'w1', wsNickname: null, wsAvatarUrl: null }),
    ).toThrow();
  });
});

describe('message:created payload', () => {
  it('requires authorId and forbids senderId field', () => {
    const parsed = MessageCreatedPayloadSchema.parse({
      seq: 5,
      message: {
        id: 'm1',
        channelId: 'c1',
        authorId: 'u1',
        authorName: 'alice',
        authorAvatarUrl: null,
        content: 'hi',
        createdAt: ISO,
        editedAt: null,
      },
    });
    expect('authorId' in parsed.message).toBe(true);
    expect('senderId' in parsed.message).toBe(false);
  });

  it('accepts seq=-1 sentinel', () => {
    expect(() =>
      MessageCreatedPayloadSchema.parse({
        seq: -1,
        message: {
          id: 'm1',
          channelId: 'c1',
          authorId: null,
          authorName: 'system',
          authorAvatarUrl: null,
          content: null,
          createdAt: ISO,
          editedAt: null,
        },
      }),
    ).not.toThrow();
  });
});

describe('message:updated payload (D01/ADR-12 parity)', () => {
  it('carries the D17-specified fields', () => {
    const parsed = MessageUpdatedPayloadSchema.parse({
      seq: 7,
      messageId: 'm1',
      channelId: 'c1',
      contentRaw: '**hi**',
      contentPlain: 'hi',
      contentAst: { type: 'root', children: [] },
      version: 2,
      editedAt: ISO,
      mentions: { users: [], channels: [], everyone: false },
    });
    expect(parsed.contentRaw).toBe('**hi**');
    expect(parsed.contentPlain).toBe('hi');
    expect(parsed.version).toBe(2);
    expect(parsed.mentions.here).toBe(false); // default applied
  });

  it('rejects a payload missing contentAst', () => {
    expect(() =>
      MessageUpdatedPayloadSchema.parse({
        seq: 7,
        messageId: 'm1',
        channelId: 'c1',
        contentRaw: 'x',
        contentPlain: 'x',
        version: 1,
        editedAt: null,
        mentions: { users: [], channels: [], everyone: false },
      }),
    ).toThrow();
  });

  // 리뷰 [H2]: mrkdwn 파서가 추출한 cuid2 멘션 토큰이 mentions 페이로드를
  // 통과해야 한다. 이전 MessageMentionsSchema 는 z.string().uuid() 라
  // 파서가 뽑은 `@{cuid2}` 토큰을 런타임에서 거부했다.
  it('accepts cuid2 mention ids extracted by the mrkdwn parser', () => {
    const userId = extractMentionUserIds('@{clh3z2k0v0000abcd1234ef}')[0];
    expect(userId).toBe('clh3z2k0v0000abcd1234ef');
    const parsed = MessageUpdatedPayloadSchema.parse({
      seq: 7,
      messageId: 'm1',
      channelId: 'c1',
      contentRaw: 'hi @{clh3z2k0v0000abcd1234ef}',
      contentPlain: 'hi @alice',
      contentAst: { type: 'root', children: [] },
      version: 2,
      editedAt: ISO,
      mentions: { users: [userId], channels: ['clh3z2k0v0000chan5678gh'], everyone: false },
    });
    expect(parsed.mentions.users).toEqual([userId]);
  });

  // expand-contract: 라이브 데이터가 uuid 이므로 과도기엔 uuid 도 수용해야
  // 한다(좁히면 라이브 멘션이 깨짐). cuid2 단독 전환은 S01 마이그레이션 후.
  it('accepts a uuid in mentions.users during the transitional window (S01에서 cuid2 단독)', () => {
    const uuid = '00000000-0000-0000-0000-000000000000';
    const parsed = MessageUpdatedPayloadSchema.parse({
      seq: 7,
      messageId: 'm1',
      channelId: 'c1',
      contentRaw: 'x',
      contentPlain: 'x',
      contentAst: { type: 'root', children: [] },
      version: 1,
      editedAt: null,
      mentions: {
        users: [uuid],
        channels: [],
        everyone: false,
      },
    });
    expect(parsed.mentions.users).toEqual([uuid]);
  });
});

describe('read_state / presence / typing payloads', () => {
  it('read_state:updated requires channelId + unreadCount', () => {
    const p = ReadStateUpdatedPayloadSchema.parse({
      channelId: 'c1',
      lastReadMessageId: 'm9',
      unreadCount: 3,
    });
    expect(p.unreadCount).toBe(3);
    expect(() =>
      ReadStateUpdatedPayloadSchema.parse({
        channelId: 'c1',
        lastReadMessageId: null,
        unreadCount: -1,
      }),
    ).toThrow();
  });

  // S36 (FR-RS-12 / FR-TH-12): 스레드 읽음 ACK 요청 바디.
  it('thread ack requires a uuid lastReadMessageId', () => {
    expect(
      ThreadAckRequestSchema.parse({ lastReadMessageId: '44444444-4444-4444-8444-444444444444' })
        .lastReadMessageId,
    ).toBe('44444444-4444-4444-8444-444444444444');
    expect(() => ThreadAckRequestSchema.parse({ lastReadMessageId: 'not-a-uuid' })).toThrow();
    expect(() => ThreadAckRequestSchema.parse({})).toThrow();
  });

  it('presence:update enforces the 5 status values (S25 + invisible)', () => {
    for (const status of ['online', 'idle', 'dnd', 'offline', 'invisible'] as const) {
      expect(() =>
        PresenceUpdatePayloadSchema.parse({ userId: 'u1', status, updatedAt: ISO }),
      ).not.toThrow();
    }
    expect(() =>
      PresenceUpdatePayloadSchema.parse({ userId: 'u1', status: 'away', updatedAt: ISO }),
    ).toThrow();
  });

  // S25 fix-forward(security HIGH · DoS): presence:subscribe userIds is bounded.
  it('presence:subscribe caps userIds at 500 (DoS guard)', () => {
    const ok = Array.from({ length: 500 }, (_, i) => `u${i}`);
    expect(() => PresenceSubscribePayloadSchema.parse({ userIds: ok })).not.toThrow();
    const tooMany = Array.from({ length: 501 }, (_, i) => `u${i}`);
    expect(() => PresenceSubscribePayloadSchema.parse({ userIds: tooMany })).toThrow();
  });

  // S26 (FR-P16): presence:unsubscribe is in the WS catalog with a 500-cap
  // payload mirroring presence:subscribe.
  it('presence:unsubscribe is typed in the WS catalog with a 500-cap payload', () => {
    expect(WS_EVENTS.PRESENCE_UNSUBSCRIBE).toBe('presence:unsubscribe');
    expect(WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.PRESENCE_UNSUBSCRIBE]).toBeDefined();
    expect(() => PresenceUnsubscribePayloadSchema.parse({ userIds: ['u1', 'u2'] })).not.toThrow();
    const tooMany = Array.from({ length: 501 }, (_, i) => `u${i}`);
    expect(() => PresenceUnsubscribePayloadSchema.parse({ userIds: tooMany })).toThrow();
  });

  // S26 (FR-P16): presence:update (per-subscriber fan-out) carries a single
  // PresenceEntry shape and is registered for the user:{userId} room push.
  it('presence:update carries a single PresenceEntry for subscriber fan-out', () => {
    expect(WS_EVENTS.PRESENCE_UPDATE).toBe('presence:update');
    expect(WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.PRESENCE_UPDATE]).toBeDefined();
    const parsed = PresenceUpdatePayloadSchema.parse({
      userId: 'u1',
      status: 'online',
      updatedAt: ISO,
    });
    expect(parsed.userId).toBe('u1');
    expect(parsed.status).toBe('online');
  });

  // S25 fix-forward(contract HIGH): workspace presence broadcast is typed +
  // registered in the WS catalog. Wire name stays the dot form.
  it('presence.updated (WORKSPACE_PRESENCE_UPDATED) is typed in the WS catalog', () => {
    expect(WS_EVENTS.WORKSPACE_PRESENCE_UPDATED).toBe('presence.updated');
    const schema = WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.WORKSPACE_PRESENCE_UPDATED];
    expect(schema).toBeDefined();
    const parsed = WorkspacePresenceUpdatedPayloadSchema.parse({
      workspaceId: 'w1',
      onlineUserIds: ['u1', 'u2'],
      dndUserIds: ['u2'],
      idleUserIds: ['u1'],
    });
    expect(parsed.onlineUserIds).toEqual(['u1', 'u2']);
    expect(parsed.dndUserIds).toEqual(['u2']);
    expect(parsed.idleUserIds).toEqual(['u1']);
    // arrays are required (a server always sends all three sets).
    expect(() =>
      WorkspacePresenceUpdatedPayloadSchema.parse({ workspaceId: 'w1', onlineUserIds: ['u1'] }),
    ).toThrow();
  });

  it('maskPresenceForViewer hides invisible from others, reveals to self (FR-P01)', () => {
    // invisible → offline for others, real value for self.
    expect(maskPresenceForViewer('invisible', false)).toBe('offline');
    expect(maskPresenceForViewer('invisible', true)).toBe('invisible');
    // every other status passes through unchanged regardless of viewer.
    for (const status of ['online', 'idle', 'dnd', 'offline'] as const) {
      expect(maskPresenceForViewer(status, false)).toBe(status);
      expect(maskPresenceForViewer(status, true)).toBe(status);
    }
  });

  // S32 fix-forward(contract CRITICAL · 4팀 합의): typing:update / typing:batch
  // 의 와이어 형태는 `{ channelId, typingUserIds:[...] }` 로 통일됐다(종전 선언
  // 스키마의 {userId, displayName, action} / batch 의 {userIds} 는 라이브 와이어와
  // 어긋난 거짓 계약이었다). 실제 와이어 페이로드가 각 스키마로 parse 성공하는지,
  // 그리고 WS_EVENT_PAYLOAD_SCHEMAS 매핑이 동일 스키마를 가리키는지 가드한다.
  it('typing:update parses the live wire shape { channelId, typingUserIds }', () => {
    const wire = { channelId: 'c1', typingUserIds: ['u1', 'u2'] };
    expect(TypingUpdatePayloadSchema.parse(wire).typingUserIds).toEqual(['u1', 'u2']);
    // 0명 clear snapshot 도 유효.
    expect(
      TypingUpdatePayloadSchema.parse({ channelId: 'c1', typingUserIds: [] }).typingUserIds,
    ).toEqual([]);
    // 종전 거짓 계약 필드(userId/displayName/action)는 더는 강제되지 않으며,
    // typingUserIds 가 누락되면 거부된다.
    expect(() => TypingUpdatePayloadSchema.parse({ channelId: 'c1' })).toThrow();
  });

  it('typing:batch parses the live wire shape { channelId, typingUserIds } (empty allowed)', () => {
    expect(
      TypingBatchPayloadSchema.parse({ channelId: 'c1', typingUserIds: [] }).typingUserIds,
    ).toEqual([]);
    expect(
      TypingBatchPayloadSchema.parse({ channelId: 'c1', typingUserIds: ['u1'] }).typingUserIds,
    ).toEqual(['u1']);
  });

  it('typing:update / typing:batch cap typingUserIds at TYPING_MAX_VISIBLE', () => {
    const overflow = Array.from({ length: TYPING_MAX_VISIBLE + 1 }, (_, i) => `u${i}`);
    expect(() =>
      TypingUpdatePayloadSchema.parse({ channelId: 'c1', typingUserIds: overflow }),
    ).toThrow();
    expect(() =>
      TypingBatchPayloadSchema.parse({ channelId: 'c1', typingUserIds: overflow }),
    ).toThrow();
  });

  it('WS_EVENT_PAYLOAD_SCHEMAS maps typing:update / typing:batch to the aligned schemas', () => {
    expect(WS_EVENTS.TYPING_BATCH).toBe('typing:batch');
    expect(WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.TYPING_UPDATE]).toBe(TypingUpdatePayloadSchema);
    expect(WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.TYPING_BATCH]).toBe(TypingBatchPayloadSchema);
  });

  it('message:deleted carries deletedAt iso', () => {
    expect(() =>
      MessageDeletedPayloadSchema.parse({
        seq: 1,
        messageId: 'm1',
        channelId: 'c1',
        deletedAt: ISO,
      }),
    ).not.toThrow();
  });

  // S99 (S05-verify carryover · LOW): version 은 optional 후방호환 — 없어도 통과,
  // 있으면 비음수 정수로 검증되고 파싱 결과에 보존된다.
  it('message:deleted version 은 optional (구 서버 호환)', () => {
    const p = MessageDeletedPayloadSchema.parse({
      seq: 2,
      messageId: 'm2',
      channelId: 'c2',
      deletedAt: ISO,
    });
    expect(p.version).toBeUndefined();
  });

  it('message:deleted 가 version 을 실으면 baseline 으로 보존', () => {
    const p = MessageDeletedPayloadSchema.parse({
      seq: 3,
      messageId: 'm3',
      channelId: 'c3',
      deletedAt: ISO,
      version: 5,
    });
    expect(p.version).toBe(5);
    // 음수 version 은 거부.
    expect(() =>
      MessageDeletedPayloadSchema.parse({
        seq: 4,
        messageId: 'm4',
        channelId: 'c4',
        deletedAt: ISO,
        version: -1,
      }),
    ).toThrow();
  });

  it('channel:joined carries seq snapshot + lastMessageId', () => {
    const p = ChannelJoinedPayloadSchema.parse({
      channelId: 'c1',
      seq: 42,
      lastMessageId: 'm10',
      unreadCount: 0,
      lastReadMessageId: null,
    });
    expect(p.seq).toBe(42);
    expect(p.lastMessageId).toBe('m10');
  });
});

// S38 fix-forward (contract HIGH): thread:lock:changed payload 의 actorId.
describe('thread:lock:changed payload', () => {
  it('requires actorId (서버 emit payload 와 정합)', () => {
    const p = ThreadLockChangedPayloadSchema.parse({
      workspaceId: 'w1',
      channelId: 'c1',
      actorId: 'u-actor',
      parentMessageId: 'm-root',
      locked: true,
    });
    expect(p.actorId).toBe('u-actor');
    expect(p.locked).toBe(true);
  });

  it('rejects a payload missing actorId', () => {
    expect(() =>
      ThreadLockChangedPayloadSchema.parse({
        workspaceId: 'w1',
        channelId: 'c1',
        parentMessageId: 'm-root',
        locked: false,
      }),
    ).toThrow();
  });
});

// S69 (FR-W20/W23): connection:ready 멘션 카운트 + unread_count:increment workspaceId.
describe('S69 connection:ready allWorkspaceMentionCounts', () => {
  it('가입한 모든 워크스페이스 멘션 카운트를 싣는다', () => {
    const p = ConnectionReadyPayloadSchema.parse({
      userId: 'u1',
      sessionId: 's1',
      allWorkspaceMentionCounts: [
        { workspaceId: 'w1', mentionCount: 3 },
        { workspaceId: 'w2', mentionCount: 0 },
      ],
    });
    expect(p.allWorkspaceMentionCounts).toHaveLength(2);
    expect(p.allWorkspaceMentionCounts?.[0]).toEqual({ workspaceId: 'w1', mentionCount: 3 });
  });

  it('forward-compat — allWorkspaceMentionCounts 누락도 허용한다(구 서버)', () => {
    const p = ConnectionReadyPayloadSchema.parse({ userId: 'u1', sessionId: 's1' });
    expect(p.allWorkspaceMentionCounts).toBeUndefined();
  });
});

describe('S69 unread_count:increment workspaceId', () => {
  it('workspaceId 를 함께 싣는다(활성 무관 모든 워크스페이스)', () => {
    const p = UnreadCountIncrementPayloadSchema.parse({
      channelId: 'c1',
      delta: 1,
      workspaceId: 'w1',
    });
    expect(p.workspaceId).toBe('w1');
  });

  it('forward-compat — workspaceId 누락도 허용한다(구 서버)', () => {
    const p = UnreadCountIncrementPayloadSchema.parse({ channelId: 'c1', delta: 1 });
    expect(p.workspaceId).toBeUndefined();
  });
});

// S88b (FR-MN-03 / FR-MN-19): @role 멘션 async fanout. mention-broadcast 워커가 만든
// mention.received outbox → outbox-to-ws subscriber 가 mention:new 로 변환해 emit 하는
// payload 가 MentionNewPayloadSchema 와 정합해야 한다(role=true · 직접 @user 와 동일 형태).
describe('S88b mention:new role payload (FR-MN-03 async fanout)', () => {
  it('accepts a role-mention payload with role=true (역할 유래 표식)', () => {
    const p = MentionNewPayloadSchema.parse({
      targetUserId: 'u1',
      workspaceId: 'w1',
      channelId: 'c1',
      messageId: 'm1',
      actorId: 'a1',
      snippet: 'hello @Designers',
      createdAt: '2025-01-01T00:00:00.000Z',
      everyone: false,
      here: false,
      role: true,
    });
    expect(p.role).toBe(true);
  });

  it('forward-compat — role 누락도 허용한다(@user 동기 경로 구 payload)', () => {
    const p = MentionNewPayloadSchema.parse({
      targetUserId: 'u1',
      workspaceId: 'w1',
      channelId: 'c1',
      messageId: 'm1',
      actorId: 'a1',
      snippet: 'hi',
      createdAt: '2025-01-01T00:00:00.000Z',
      everyone: false,
      here: false,
    });
    expect(p.role).toBeUndefined();
  });
});
