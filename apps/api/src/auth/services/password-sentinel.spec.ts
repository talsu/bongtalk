import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordService } from './password.service';

/**
 * S72 fix-forward (security HIGH = #5): the SYSTEM_ANON user is seeded
 * (seed.ts) and inserted by the purge worker (workspace-purge.sh) with a
 * NON-argon2 sentinel passwordHash of the form `x-no-login-<uuid>`. Because
 * that string is not a valid argon2 encoded hash, argon2.verify() throws and
 * PasswordService.verify() returns false for EVERY candidate plaintext — so
 * login is structurally impossible, not merely "hard to guess". This pins that
 * guarantee so a future change can't accidentally seed a real (loginable) hash.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('PasswordService — SYSTEM_ANON sentinel hash is unloginable (FR-W15 / #5)', () => {
  const svc = new PasswordService();
  const anonId = '871aa8f6-f28a-5e26-ba8f-37ca7126e9e3';
  const sentinel = `x-no-login-${anonId}`;

  it('verify() returns false for the empty password against the sentinel', async () => {
    expect(await svc.verify(sentinel, '')).toBe(false);
  });

  it('verify() returns false for the (formerly derivable) plaintext against the sentinel', async () => {
    // The old seed derived `anon-<id>-no-login` and argon2-hashed it; that
    // plaintext is public-derivable. Against the sentinel it cannot match.
    expect(await svc.verify(sentinel, `anon-${anonId}-no-login`)).toBe(false);
  });

  it('verify() returns false for arbitrary plaintexts (no plaintext maps to a non-argon2 string)', async () => {
    for (const p of ['Password1!', 'admin', sentinel, 'x-no-login-', '$argon2id$']) {
      expect(await svc.verify(sentinel, p)).toBe(false);
    }
  });
});
