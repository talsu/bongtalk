import { describe, expect, it } from 'vitest';
import {
  ChangeEmailRequestSchema,
  ChangePasswordRequestSchema,
  SessionSummarySchema,
  TOTP_BACKUP_CODE_COUNT,
  TOTP_CODE_LENGTH,
  TotpDisableRequestSchema,
  TotpSetupResponseSchema,
  TotpVerifyRequestSchema,
  TotpVerifyResponseSchema,
} from './security';
import { ErrorCodeSchema } from './index';

describe('S77b security (FR-PS-15·20) Zod', () => {
  it('ChangePassword requires currentPassword + policy-compliant newPassword', () => {
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: 'old-secret',
        newPassword: 'new-strong-1',
      }).success,
    ).toBe(true);
    // newPassword < 8 거부.
    expect(
      ChangePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success,
    ).toBe(false);
    // 미지의 키 거부(strict).
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: 'x',
        newPassword: 'new-strong-1',
        bogus: 1,
      }).success,
    ).toBe(false);
  });

  it('ChangeEmail requires currentPassword + valid email', () => {
    expect(
      ChangeEmailRequestSchema.safeParse({ currentPassword: 'x', newEmail: 'a@b.com' }).success,
    ).toBe(true);
    expect(
      ChangeEmailRequestSchema.safeParse({ currentPassword: 'x', newEmail: 'not-an-email' })
        .success,
    ).toBe(false);
  });

  // SF2·SF3: 2FA 활성 사용자용 totpCode 는 optional(누락 well-formed) + 형식(6자리 숫자) 검증.
  it('ChangeEmail/ChangePassword accept an optional 6-digit totpCode', () => {
    expect(
      ChangeEmailRequestSchema.safeParse({
        currentPassword: 'x',
        newEmail: 'a@b.com',
        totpCode: '123456',
      }).success,
    ).toBe(true);
    // 형식 위반(5자리)은 거부.
    expect(
      ChangeEmailRequestSchema.safeParse({
        currentPassword: 'x',
        newEmail: 'a@b.com',
        totpCode: '12345',
      }).success,
    ).toBe(false);
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: 'old',
        newPassword: 'new-strong-1',
        totpCode: '654321',
      }).success,
    ).toBe(true);
    // 누락은 여전히 허용(2FA 미활성 사용자 — 서버가 totpEnabled 로 강제).
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: 'old',
        newPassword: 'new-strong-1',
      }).success,
    ).toBe(true);
  });

  it('TotpVerify requires a 6-digit numeric code', () => {
    expect(TotpVerifyRequestSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(TotpVerifyRequestSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(TotpVerifyRequestSchema.safeParse({ code: 'abcdef' }).success).toBe(false);
    expect(TOTP_CODE_LENGTH).toBe(6);
  });

  it('TotpDisable accepts a missing totpCode (server enforces TOTP_CODE_REQUIRED)', () => {
    expect(TotpDisableRequestSchema.safeParse({ currentPassword: 'x' }).success).toBe(true);
    expect(
      TotpDisableRequestSchema.safeParse({ currentPassword: 'x', totpCode: '123456' }).success,
    ).toBe(true);
    // 잘못된 형식의 코드는 거부(누락은 허용·잘못된 형식은 거부).
    expect(
      TotpDisableRequestSchema.safeParse({ currentPassword: 'x', totpCode: '12' }).success,
    ).toBe(false);
  });

  it('TotpVerifyResponse requires exactly 10 backup codes', () => {
    const codes = Array.from({ length: TOTP_BACKUP_CODE_COUNT }, (_, i) => `code${i}`);
    expect(
      TotpVerifyResponseSchema.safeParse({ totpEnabled: true, backupCodes: codes }).success,
    ).toBe(true);
    expect(
      TotpVerifyResponseSchema.safeParse({ totpEnabled: true, backupCodes: codes.slice(0, 5) })
        .success,
    ).toBe(false);
    expect(TOTP_BACKUP_CODE_COUNT).toBe(10);
  });

  it('TotpSetupResponse carries otpauthUri + secret + qrDataUri', () => {
    expect(
      TotpSetupResponseSchema.safeParse({
        otpauthUri: 'otpauth://totp/qufox:a@b.com?secret=ABC',
        secret: 'ABC',
        qrDataUri: 'data:image/png;base64,xxx',
      }).success,
    ).toBe(true);
  });

  it('SessionSummary requires isCurrent + nullable device fields', () => {
    expect(
      SessionSummarySchema.safeParse({
        id: '00000000-0000-4000-8000-000000000000',
        deviceName: null,
        ip: null,
        userAgent: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        lastSeenAt: null,
        isCurrent: true,
      }).success,
    ).toBe(true);
  });

  it('ErrorCodeSchema accepts the new S77b codes', () => {
    for (const code of [
      'PASSWORD_INCORRECT',
      'TOTP_CODE_REQUIRED',
      'TOTP_INVALID',
      'TOTP_ALREADY_ENABLED',
      'TOTP_NOT_ENABLED',
      'SESSION_NOT_FOUND',
      'ENCRYPTION_UNAVAILABLE',
    ]) {
      expect(() => ErrorCodeSchema.parse(code)).not.toThrow();
    }
  });
});
