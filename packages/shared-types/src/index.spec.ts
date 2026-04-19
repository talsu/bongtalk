import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCodeSchema, HealthResponseSchema, MessageDtoSchema, UserSchema } from './index';

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

  it('MessageDtoSchema enforces content bounds and masks when deleted', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000001',
      channelId: '00000000-0000-0000-0000-000000000002',
      authorId: '00000000-0000-0000-0000-000000000003',
      mentions: { users: [], channels: [], everyone: false },
      edited: false,
      deleted: true,
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    // content=null valid when deleted=true
    expect(() => MessageDtoSchema.parse({ ...base, content: null })).not.toThrow();
    // empty string still invalid (min(1) on the content schema)
    expect(() => MessageDtoSchema.parse({ ...base, content: '' })).toThrow();
  });
});
