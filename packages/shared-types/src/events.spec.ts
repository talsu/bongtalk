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
  TypingBatchPayloadSchema,
  ChannelJoinedPayloadSchema,
  maskPresenceForViewer,
} from './events';
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

  it('every event name has a payload schema and names are unique', () => {
    const names = Object.values(WS_EVENTS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(WS_EVENT_PAYLOAD_SCHEMAS[name]).toBeDefined();
    }
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

  it('typing:batch userIds is a full snapshot (empty allowed)', () => {
    expect(TypingBatchPayloadSchema.parse({ channelId: 'c1', userIds: [] }).userIds).toEqual([]);
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
