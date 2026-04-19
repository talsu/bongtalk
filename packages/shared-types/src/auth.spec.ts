import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AuthTokensResponseSchema,
  LoginRequestSchema,
  SignupRequestSchema,
} from './auth';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('auth schemas', () => {
  it('SignupRequestSchema enforces min lengths', () => {
    expect(() =>
      SignupRequestSchema.parse({ email: 'a@b.co', username: 'u', password: '12345678' }),
    ).toThrow();
    const ok = SignupRequestSchema.parse({
      email: 'alice@qufox.dev',
      username: 'alice',
      password: 'Password1!',
    });
    expect(ok.username).toBe('alice');
  });

  it('SignupRequestSchema rejects invalid username chars', () => {
    expect(() =>
      SignupRequestSchema.parse({
        email: 'a@b.co',
        username: 'alice!space',
        password: 'Password1!',
      }),
    ).toThrow();
  });

  it('LoginRequestSchema requires email + password', () => {
    expect(() => LoginRequestSchema.parse({ email: 'x', password: 'y' })).toThrow();
    expect(LoginRequestSchema.parse({ email: 'a@b.co', password: 'pw' }).email).toBe('a@b.co');
  });

  it('AuthTokensResponseSchema round-trips', () => {
    const r = AuthTokensResponseSchema.parse({
      accessToken: 'xxxxxxxxxxxx',
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'alice@qufox.dev',
        username: 'alice',
        createdAt: new Date().toISOString(),
      },
    });
    expect(r.user.username).toBe('alice');
  });
});
