import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cursorFor, decodeCursor, encodeCursor } from '../../../src/messages/cursor/cursor';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('cursor', () => {
  const VALID = {
    t: '2025-01-01T00:00:00.000Z',
    id: '11111111-1111-4111-8111-111111111111',
  };

  it('encode → decode round-trip preserves payload', () => {
    const token = encodeCursor(VALID);
    expect(decodeCursor(token)).toEqual(VALID);
  });

  it('cursorFor accepts Date or ISO string', () => {
    const iso = cursorFor({ createdAt: '2025-01-02T03:04:05.678Z', id: VALID.id });
    const d = cursorFor({ createdAt: new Date('2025-01-02T03:04:05.678Z'), id: VALID.id });
    expect(iso).toBe(d);
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

  it('rejects payload missing t', () => {
    const tok = Buffer.from(JSON.stringify({ id: VALID.id }), 'utf8').toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects payload missing id', () => {
    const tok = Buffer.from(JSON.stringify({ t: VALID.t }), 'utf8').toString('base64url');
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects non-UUID id', () => {
    const tok = Buffer.from(JSON.stringify({ t: VALID.t, id: 'not-a-uuid' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(tok)).toThrow(DomainError);
  });

  it('rejects non-ISO t', () => {
    const tok = Buffer.from(JSON.stringify({ t: 'yesterday', id: VALID.id }), 'utf8').toString(
      'base64url',
    );
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
