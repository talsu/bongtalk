import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertWorkspaceEntryAllowed } from './workspace-entry-gate';
import { ErrorCode } from '../common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('S66 assertWorkspaceEntryAllowed (FR-W05a)', () => {
  it('emailVerified=false 면 EMAIL_NOT_VERIFIED 로 거부한다', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: false,
        userEmail: 'a@acme.com',
        emailDomains: [],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.EMAIL_NOT_VERIFIED }));
  });

  it('emailDomains 빈 배열이면 인증된 사용자는 통과한다(제한 없음)', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: true,
        userEmail: 'a@anything.com',
        emailDomains: [],
      }),
    ).not.toThrow();
  });

  it('도메인 exact-match 시 통과한다', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: true,
        userEmail: 'a@acme.com',
        emailDomains: ['acme.com'],
      }),
    ).not.toThrow();
  });

  it('도메인 대소문자는 무시하고 비교한다', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: true,
        userEmail: 'A@Acme.COM',
        emailDomains: ['ACME.com'],
      }),
    ).not.toThrow();
  });

  it('도메인 불일치 시 WORKSPACE_DOMAIN_NOT_ALLOWED 로 거부한다', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: true,
        userEmail: 'a@gmail.com',
        emailDomains: ['acme.com'],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.WORKSPACE_DOMAIN_NOT_ALLOWED }));
  });

  it('서브도메인은 exact-match 가 아니므로 거부한다(sub.acme.com ≠ acme.com)', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: true,
        userEmail: 'a@sub.acme.com',
        emailDomains: ['acme.com'],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.WORKSPACE_DOMAIN_NOT_ALLOWED }));
  });

  it('emailVerified 게이트가 도메인 게이트보다 우선한다(미인증 + 도메인 일치라도 거부)', () => {
    expect(() =>
      assertWorkspaceEntryAllowed({
        emailVerified: false,
        userEmail: 'a@acme.com',
        emailDomains: ['acme.com'],
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.EMAIL_NOT_VERIFIED }));
  });
});
