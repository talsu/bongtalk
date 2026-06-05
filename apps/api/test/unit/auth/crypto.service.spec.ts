import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CryptoService } from '../../../src/auth/services/crypto.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

// 32바이트 base64 dev 키(테스트 전용 — 실 키 아님).
const KEY_32 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('S77b CryptoService (FR-PS-15) — AES-256-GCM', () => {
  const original = process.env.APP_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_32;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = original;
  });

  it('encrypt → decrypt roundtrip 으로 평문을 복원한다', () => {
    const svc = new CryptoService();
    const plain = 'JBSWY3DPEHPK3PXP'; // base32 TOTP 시크릿 형태.
    const blob = svc.encrypt(plain);
    expect(blob).not.toContain(plain); // 암호문에 평문이 노출되지 않는다.
    expect(blob.split(':')).toHaveLength(3); // iv:tag:ciphertext.
    expect(svc.decrypt(blob)).toBe(plain);
  });

  it('같은 평문도 매번 다른 암호문을 낸다(랜덤 IV)', () => {
    const svc = new CryptoService();
    const a = svc.encrypt('same-secret');
    const b = svc.encrypt('same-secret');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same-secret');
    expect(svc.decrypt(b)).toBe('same-secret');
  });

  it('isAvailable() 는 32바이트 키가 있으면 true', () => {
    expect(new CryptoService().isAvailable()).toBe(true);
  });

  it('키 미설정이면 isAvailable=false + encrypt 가 ENCRYPTION_UNAVAILABLE 을 던진다(크래시 금지)', () => {
    delete process.env.APP_ENCRYPTION_KEY;
    const svc = new CryptoService();
    expect(svc.isAvailable()).toBe(false);
    try {
      svc.encrypt('x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(ErrorCode.ENCRYPTION_UNAVAILABLE);
    }
  });

  it('키가 32바이트가 아니면 ENCRYPTION_UNAVAILABLE(graceful)', () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    const svc = new CryptoService();
    expect(svc.isAvailable()).toBe(false);
  });

  it('변조된 암호문(tag 불일치)은 decrypt 가 throw 한다', () => {
    const svc = new CryptoService();
    const blob = svc.encrypt('secret');
    const [iv, , ct] = blob.split(':');
    const tampered = `${iv}:${Buffer.from('00000000000000000000000000000000', 'hex').toString('base64')}:${ct}`;
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('잘못된 포맷(콜론 부족)은 decrypt 가 throw 한다', () => {
    const svc = new CryptoService();
    expect(() => svc.decrypt('not-a-valid-blob')).toThrow();
  });
});
