import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCodeSchema, HealthResponseSchema, MessageSchema, UserSchema } from './index';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('shared-types', () => {
  it('UserSchema accepts a valid user', () => {
    const user = UserSchema.parse({
      id: '00000000-0000-0000-0000-000000000001',
      email: 'alice@example.com',
      username: 'alice',
      createdAt: new Date().toISOString(),
    });
    expect(user.username).toBe('alice');
  });

  it('ErrorCodeSchema rejects unknown codes', () => {
    expect(() => ErrorCodeSchema.parse('NOPE')).toThrow();
    expect(ErrorCodeSchema.parse('VALIDATION_FAILED')).toBe('VALIDATION_FAILED');
  });

  it('HealthResponseSchema requires status=ok', () => {
    expect(() => HealthResponseSchema.parse({ status: 'bad', version: '0', uptime: 0 })).toThrow();
  });

  it('MessageSchema enforces content bounds', () => {
    expect(() =>
      MessageSchema.parse({
        id: '00000000-0000-0000-0000-000000000001',
        channelId: '00000000-0000-0000-0000-000000000002',
        authorId: '00000000-0000-0000-0000-000000000003',
        content: '',
        createdAt: new Date().toISOString(),
        deletedAt: null,
      }),
    ).toThrow();
  });
});
