import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PasswordService } from '../../../src/auth/services/password.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  process.env.ARGON2_MEMORY_KIB = '19456';
  process.env.ARGON2_TIME_COST = '2';
  process.env.ARGON2_PARALLELISM = '1';
});

describe('PasswordService', () => {
  it('hashes then verifies', async () => {
    const svc = new PasswordService();
    const h = await svc.hash('StrongPass!23');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'StrongPass!23')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
  });

  it('rejects short password', () => {
    const svc = new PasswordService();
    expect(() => svc.validateStrength('short1!')).toThrow(DomainError);
  });

  it('rejects password with fewer than 3 char classes', () => {
    const svc = new PasswordService();
    try {
      svc.validateStrength('alllowercaseletters');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as DomainError).code).toBe(ErrorCode.AUTH_WEAK_PASSWORD);
    }
  });

  it('accepts a password meeting length + 3-class rule', () => {
    const svc = new PasswordService();
    // 8 chars, 4 classes — reason-based rules pass even when zxcvbn would score low.
    expect(() => svc.validateStrength('Hjkim12$')).not.toThrow();
    expect(() => svc.validateStrength('Quanta-Beetle-Nebula-42!')).not.toThrow();
  });

  it('dummyVerify swallows errors (timing guard)', async () => {
    const svc = new PasswordService();
    await expect(svc.dummyVerify('anything')).resolves.toBeUndefined();
  });
});
