import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ERROR_CODE_HTTP_STATUS, ErrorCode } from '../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('ErrorCode enum', () => {
  it('includes at least the required bootstrap + auth codes', () => {
    const required = [
      'AUTH_INVALID_TOKEN',
      'AUTH_EMAIL_TAKEN',
      'AUTH_USERNAME_TAKEN',
      'AUTH_WEAK_PASSWORD',
      'AUTH_INVALID_CREDENTIALS',
      'AUTH_ACCOUNT_LOCKED',
      'AUTH_SESSION_COMPROMISED',
      'INTERNAL',
      'NOT_FOUND',
      'RATE_LIMITED',
      'VALIDATION_FAILED',
    ];
    for (const code of required) {
      expect(Object.values(ErrorCode)).toContain(code);
    }
  });

  it('maps every code to an http status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(typeof ERROR_CODE_HTTP_STATUS[code]).toBe('number');
    }
  });

  it('task-039-D: INVALID_MAGIC_BYTES maps to 422 (not 400)', () => {
    // Magic-byte mismatch is a semantic / processing failure on a
    // syntactically valid request → 422 Unprocessable Entity. Locking
    // this in stops a future "tighten everything to 400" sweep from
    // silently regressing it.
    expect(ERROR_CODE_HTTP_STATUS[ErrorCode.INVALID_MAGIC_BYTES]).toBe(422);
  });
});
