import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ERROR_CODE_HTTP_STATUS, ErrorCode } from '../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('ErrorCode enum', () => {
  it('includes the required set', () => {
    expect(Object.values(ErrorCode).sort()).toEqual(
      ['AUTH_INVALID_TOKEN', 'INTERNAL', 'NOT_FOUND', 'RATE_LIMITED', 'VALIDATION_FAILED'].sort(),
    );
  });

  it('maps every code to an http status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(typeof ERROR_CODE_HTTP_STATUS[code]).toBe('number');
    }
  });
});
