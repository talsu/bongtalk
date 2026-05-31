import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cursorFor, decodeCursor, encodeCursor } from '../../../src/messages/cursor/cursor';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('cursor (S03 / FR-MSG-21 — base64url(JSON{id,createdAt}) opaque)', () => {
  const VALID = {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2025-01-01T00:00:00.000Z',
  };

  it('encode → decode round-trip preserves payload', () => {
    const token = encodeCursor(VALID);
    expect(decodeCursor(token)).toEqual(VALID);
  });

  it('encodes the canonical { id, createdAt } JSON shape (not legacy { t, id })', () => {
    const token = encodeCursor(VALID);
    const json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(json).sort()).toEqual(['createdAt', 'id']);
    expect(json).not.toHaveProperty('t');
  });

  it('cursorFor accepts Date or ISO string', () => {
    const iso = cursorFor({ createdAt: '2025-01-02T03:04:05.678Z', id: VALID.id });
    const d = cursorFor({ createdAt: new Date('2025-01-02T03:04:05.678Z'), id: VALID.id });
    expect(iso).toBe(d);
  });

  it('cursorFor → decodeCursor yields the row tuple back', () => {
    const token = cursorFor({ createdAt: new Date('2025-01-02T03:04:05.678Z'), id: VALID.id });
    expect(decodeCursor(token)).toEqual({ id: VALID.id, createdAt: '2025-01-02T03:04:05.678Z' });
  });

  // S03 review MAJOR #2: the cursor id is UUID-ONLY. `Message.id` is `@db.Uuid`
  // and the read path binds `$4::uuid`, so a cuid2 cursor would die at the SQL
  // cast — the decoder rejects it up front to keep JS + SQL aligned.
  it('rejects a cuid2 id (uuid-only; $4::uuid cast parity)', () => {
    const cuid = 'ck9x8v7b6a5z4y3w2u1t0s9r';
    const tok = Buffer.from(
      JSON.stringify({ id: cuid, createdAt: VALID.createdAt }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  // expand-contract: a live client may still hold a legacy { t, id } token
  // across the deploy. The decoder must keep accepting it (read path) even
  // though the encoder no longer emits it.
  it('still decodes a legacy { t, id } token (wire back-compat)', () => {
    const legacy = Buffer.from(
      JSON.stringify({ t: VALID.createdAt, id: VALID.id }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(legacy)).toEqual(VALID);
  });

  it('rejects empty string', () => {
    expect(() => decodeCursor('')).toThrow(DomainError);
  });

  it('rejects base64 that is not utf8 json', () => {
    const bad = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url');
    try {
      decodeCursor(bad);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as DomainError).code).toBe(ErrorCode.MESSAGE_CURSOR_INVALID);
    }
  });

  it('rejects payload missing createdAt/t', () => {
    const tok = Buffer.from(JSON.stringify({ id: VALID.id }), 'utf8').toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects payload missing id', () => {
    const tok = Buffer.from(JSON.stringify({ createdAt: VALID.createdAt }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects a non-uuid id', () => {
    const tok = Buffer.from(
      JSON.stringify({ createdAt: VALID.createdAt, id: 'not-a-valid-id!' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects non-ISO createdAt', () => {
    const tok = Buffer.from(
      JSON.stringify({ createdAt: 'yesterday', id: VALID.id }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects token that exceeds 512 chars', () => {
    expect(() => decodeCursor('a'.repeat(513))).toThrow(DomainError);
  });

  it('rejects malformed JSON', () => {
    const tok = Buffer.from('{not:json}', 'utf8').toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects non-object payload', () => {
    const tok = Buffer.from('"hello"', 'utf8').toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });
});
