import { describe, it, expect } from 'vitest';
import { CursorPayloadSchema, ListMessagesQuerySchema, SendMessageRequestSchema } from './message';

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
