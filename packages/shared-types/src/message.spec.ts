import { describe, it, expect } from 'vitest';
import {
  CursorPayloadSchema,
  ListMessagesQuerySchema,
  SendMessageRequestSchema,
  UpdateMessageRequestSchema,
  MessageDtoSchema,
  EditHistoryDtoSchema,
  ListEditHistoryResponseSchema,
  EDIT_HISTORY_CAP,
  THREAD_BROADCAST_EXCERPT_CAP,
  ThreadSummarySchema,
  ListThreadRepliesResponseSchema,
  ReactionSummarySchema,
  ListReactionsResponseSchema,
} from './message';

/**
 * S03 (FR-MSG-04 / FR-MSG-21) shared-contract spec.
 *
 * Covers the wire-level pieces of the messaging slice that both the API and
 * the web client depend on:
 *   - clientNonce (UUID v4) on the send body.
 *   - opaque cursor payload shape `{ id, createdAt }`.
 *   - `lastReadMessageId` must NOT be smuggled in as a pagination cursor.
 */
describe('SendMessageRequestSchema.nonce (FR-MSG-04)', () => {
  it('accepts a body carrying a uuid nonce', () => {
    const parsed = SendMessageRequestSchema.safeParse({
      content: 'hi',
      nonce: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.nonce).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('nonce is optional — omitting it still parses', () => {
    const parsed = SendMessageRequestSchema.safeParse({ content: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.nonce).toBeUndefined();
  });

  it('rejects a non-uuid nonce', () => {
    const parsed = SendMessageRequestSchema.safeParse({ content: 'hi', nonce: 'not-a-uuid' });
    expect(parsed.success).toBe(false);
  });
});

describe('CursorPayloadSchema (FR-MSG-21 — { id, createdAt })', () => {
  it('accepts the canonical { id, createdAt } shape with a uuid id', () => {
    const parsed = CursorPayloadSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  // S03 review MAJOR #2: cursor id is UUID-ONLY (matches `@db.Uuid` PK + the
  // `$4::uuid` read-path cast). The cuid2 widening was premature.
  it('rejects a cuid2 id (uuid-only contract)', () => {
    const parsed = CursorPayloadSchema.safeParse({
      id: 'ck9x8v7b6a5z4y3w2u1t0s9r',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-ISO createdAt', () => {
    const parsed = CursorPayloadSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: 'yesterday',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the legacy { t, id } shape (encoder no longer emits it)', () => {
    const parsed = CursorPayloadSchema.safeParse({
      t: '2025-01-01T00:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    });
    // `createdAt` missing → invalid as a canonical payload. (The decoder in
    // the API layer still tolerates legacy tokens — that is tested there.)
    expect(parsed.success).toBe(false);
  });
});

describe('ListMessagesQuerySchema lastReadMessageId guard (FR-MSG-21)', () => {
  it('rejects lastReadMessageId used as a cursor', () => {
    const parsed = ListMessagesQuerySchema.safeParse({
      lastReadMessageId: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects lastReadMessageId mixed with a real cursor', () => {
    const parsed = ListMessagesQuerySchema.safeParse({
      before: 'eyJpZCI6IngifQ',
      lastReadMessageId: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a plain before cursor', () => {
    const parsed = ListMessagesQuerySchema.safeParse({ before: 'eyJpZCI6IngifQ' });
    expect(parsed.success).toBe(true);
  });

  it('still enforces before/after/around mutual exclusion', () => {
    const parsed = ListMessagesQuerySchema.safeParse({ before: 'a', after: 'b' });
    expect(parsed.success).toBe(false);
  });
});

// ── S05 (FR-MSG-06 / FR-RC16) edit/delete + 낙관적 잠금 + 이력 계약 ──────────
describe('UpdateMessageRequestSchema.expectedVersion (FR-MSG-06)', () => {
  it('requires expectedVersion alongside content', () => {
    const ok = UpdateMessageRequestSchema.safeParse({ content: 'hi', expectedVersion: 3 });
    expect(ok.success).toBe(true);
  });

  it('rejects a PATCH without expectedVersion', () => {
    const bad = UpdateMessageRequestSchema.safeParse({ content: 'hi' });
    expect(bad.success).toBe(false);
  });

  it('rejects a negative expectedVersion', () => {
    const bad = UpdateMessageRequestSchema.safeParse({ content: 'hi', expectedVersion: -1 });
    expect(bad.success).toBe(false);
  });
});

describe('MessageDtoSchema.version (FR-MSG-06)', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'hi',
    mentions: { users: [], channels: [], everyone: false, here: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
  };

  it('defaults version to 0 when omitted (forward-compat with older API builds)', () => {
    const parsed = MessageDtoSchema.parse(base);
    expect(parsed.version).toBe(0);
  });

  it('carries an explicit version through', () => {
    const parsed = MessageDtoSchema.parse({ ...base, version: 7 });
    expect(parsed.version).toBe(7);
  });
});

// ── S37 (FR-MSG-17) 평문 정본 계약 ─────────────────────────────────────────
describe('MessageDtoSchema.contentPlain (FR-MSG-17)', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: '**bold**',
    mentions: { users: [], channels: [], everyone: false, here: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
  };

  it('defaults contentPlain to null when omitted (forward-compat with older API builds)', () => {
    const parsed = MessageDtoSchema.parse(base);
    expect(parsed.contentPlain).toBeNull();
  });

  it('carries an explicit plain-text content through', () => {
    const parsed = MessageDtoSchema.parse({ ...base, contentPlain: 'bold' });
    expect(parsed.contentPlain).toBe('bold');
  });

  it('accepts contentPlain=null (deleted-message masking parity with content)', () => {
    const parsed = MessageDtoSchema.parse({
      ...base,
      deleted: true,
      content: null,
      contentPlain: null,
    });
    expect(parsed.contentPlain).toBeNull();
  });
});

// ── S35 (FR-TH-06) broadcast 계약 ──────────────────────────────────────────
describe('SendMessageRequestSchema.isBroadcast (FR-TH-06)', () => {
  it('accepts isBroadcast=true on a reply send', () => {
    const parsed = SendMessageRequestSchema.safeParse({
      content: 'reply',
      parentMessageId: '11111111-1111-4111-8111-111111111111',
      isBroadcast: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isBroadcast).toBe(true);
  });

  it('isBroadcast is optional — omitting it still parses', () => {
    const parsed = SendMessageRequestSchema.safeParse({ content: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isBroadcast).toBeUndefined();
  });
});

describe('MessageDtoSchema.isBroadcast / parentExcerpt (FR-TH-06)', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'hi',
    mentions: { users: [], channels: [], everyone: false, here: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
  };

  it('defaults isBroadcast=false / parentExcerpt=null (forward-compat)', () => {
    const parsed = MessageDtoSchema.parse(base);
    expect(parsed.isBroadcast).toBe(false);
    expect(parsed.parentExcerpt).toBeNull();
  });

  it('carries a broadcast row with an excerpt', () => {
    const parsed = MessageDtoSchema.parse({
      ...base,
      isBroadcast: true,
      parentExcerpt: '루트 메시지 일부…',
    });
    expect(parsed.isBroadcast).toBe(true);
    expect(parsed.parentExcerpt).toBe('루트 메시지 일부…');
  });

  it('exposes a 50-char excerpt cap constant', () => {
    expect(THREAD_BROADCAST_EXCERPT_CAP).toBe(50);
  });
});

describe('EditHistoryDtoSchema / ListEditHistoryResponseSchema (FR-RC16)', () => {
  const entry = {
    version: 1,
    contentRaw: 'old',
    contentAst: null,
    contentPlain: 'old',
    editedAt: '2025-01-01T00:00:00.000Z',
  };

  it('parses a valid edit-history entry', () => {
    expect(EditHistoryDtoSchema.safeParse(entry).success).toBe(true);
  });

  it('allows null contentRaw / contentAst (legacy snapshot)', () => {
    expect(
      EditHistoryDtoSchema.safeParse({ ...entry, contentRaw: null, contentAst: null }).success,
    ).toBe(true);
  });

  it('rejects a non-datetime editedAt', () => {
    expect(EditHistoryDtoSchema.safeParse({ ...entry, editedAt: 'nope' }).success).toBe(false);
  });

  it('accepts up to EDIT_HISTORY_CAP items', () => {
    const items = Array.from({ length: EDIT_HISTORY_CAP }, (_, i) => ({ ...entry, version: i }));
    expect(ListEditHistoryResponseSchema.safeParse({ items }).success).toBe(true);
  });

  it('rejects more than EDIT_HISTORY_CAP items', () => {
    const items = Array.from({ length: EDIT_HISTORY_CAP + 1 }, (_, i) => ({
      ...entry,
      version: i,
    }));
    expect(ListEditHistoryResponseSchema.safeParse({ items }).success).toBe(false);
  });
});

describe('S36 — ThreadSummary.hasUnread (FR-TH-04 / FR-TH-11)', () => {
  const base = {
    replyCount: 2,
    lastRepliedAt: '2025-01-01T00:00:00.000Z',
    recentReplyUserIds: [],
  };

  it('defaults hasUnread=false (forward-compat — 구 API 응답 필드 누락)', () => {
    const parsed = ThreadSummarySchema.parse(base);
    expect(parsed.hasUnread).toBe(false);
  });

  it('carries hasUnread=true when the viewer has unread replies', () => {
    const parsed = ThreadSummarySchema.parse({ ...base, hasUnread: true });
    expect(parsed.hasUnread).toBe(true);
  });
});

describe('S36 — ListThreadRepliesResponse.readState (FR-TH-18)', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'hi',
    mentions: { users: [], channels: [], everyone: false, here: false },
    edited: false,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: null,
  };
  const pageInfo = { hasMore: false, nextCursor: null, prevCursor: null };

  it('defaults readState.lastReadMessageId=null (구 API 응답 → 최하단 스크롤)', () => {
    const parsed = ListThreadRepliesResponseSchema.parse({
      root: base,
      replies: [],
      pageInfo,
    });
    expect(parsed.readState.lastReadMessageId).toBeNull();
  });

  it('carries a lastReadMessageId cursor when present', () => {
    const cursor = '44444444-4444-4444-8444-444444444444';
    const parsed = ListThreadRepliesResponseSchema.parse({
      root: base,
      replies: [],
      readState: { lastReadMessageId: cursor },
      pageInfo,
    });
    expect(parsed.readState.lastReadMessageId).toBe(cursor);
  });

  // S38 fix-forward (reviewer MAJOR / FR-TH-08): viewerNotificationLevel.
  it('defaults viewerNotificationLevel=null (구 API 응답 / 미구독 → 벨 ALL 표시)', () => {
    const parsed = ListThreadRepliesResponseSchema.parse({
      root: base,
      replies: [],
      pageInfo,
    });
    expect(parsed.viewerNotificationLevel).toBeNull();
  });

  it('carries the stored viewerNotificationLevel when present (벨 hydration)', () => {
    const parsed = ListThreadRepliesResponseSchema.parse({
      root: base,
      replies: [],
      viewerNotificationLevel: 'OFF',
      pageInfo,
    });
    expect(parsed.viewerNotificationLevel).toBe('OFF');
  });
});

describe('S39 (SHOULD 3) — reactions contract: per-viewer vs GET-detail 형태 회귀고정', () => {
  // per-viewer REST 형태(ReactionSummary): byMe 불리언이 있고 users 는 없다.
  it('ReactionSummary 는 per-viewer byMe 를 갖는다(users 없음)', () => {
    const parsed = ReactionSummarySchema.parse({ emoji: '👍', count: 3, byMe: true });
    expect(parsed).toEqual({ emoji: '👍', count: 3, byMe: true });
  });

  // GET /messages/:id/reactions 응답은 서버 aggregateReactionDetails 의 형태와
  // 1:1 이어야 한다 — emoji/count/users[{id,username|null}]. 대표 샘플(>5명 cap 까지
  // 채운 케이스)을 safeParse 로 고정해, 둘이 어긋나면 이 테스트가 곧바로 깨진다.
  it('ListReactionsResponse 가 aggregateReactionDetails 형태(users≤5, username nullable)와 일치', () => {
    const sample = {
      reactions: [
        {
          emoji: '👍',
          count: 6,
          users: [
            { id: '11111111-1111-4111-8111-111111111111', username: 'alice' },
            { id: '22222222-2222-4222-8222-222222222222', username: null },
            { id: '33333333-3333-4333-8333-333333333333', username: 'carol' },
            { id: '44444444-4444-4444-8444-444444444444', username: 'dave' },
            { id: '55555555-5555-4555-8555-555555555555', username: 'erin' },
          ],
        },
        { emoji: '🎉', count: 0, users: [] },
      ],
    };
    const res = ListReactionsResponseSchema.safeParse(sample);
    expect(res.success).toBe(true);
  });

  it('users 가 5명을 초과하면 거부된다(서버 LATERAL LIMIT 5 와 정합)', () => {
    // 전부 유효한 uuid 라 거부 사유는 오직 .max(5) 초과뿐이다.
    const sixUsers = Array.from({ length: 6 }, (_, i) => ({
      id: `${i + 1}1111111-1111-4111-8111-111111111111`,
      username: null,
    }));
    const res = ListReactionsResponseSchema.safeParse({
      reactions: [{ emoji: '👍', count: 6, users: sixUsers }],
    });
    expect(res.success).toBe(false);
  });
});
