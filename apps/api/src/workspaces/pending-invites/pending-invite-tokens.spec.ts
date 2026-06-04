import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideAcceptBranch,
  hashToken,
  isOverlyBroadDomain,
  makeOpaqueCode,
  makeRawToken,
  normalizeEmail,
} from './pending-invite-tokens';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('S68 hashToken — sha256 store/compare (★핵심 AC)', () => {
  it('produces a deterministic 64-hex sha256', () => {
    const raw = 'some-raw-token';
    const h = hashToken(raw);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // 결정적 — 같은 입력은 같은 해시(저장값 ↔ 수락 대조에 동일).
    expect(hashToken(raw)).toBe(h);
  });

  it('never equals the raw token (no plaintext)', () => {
    const raw = makeRawToken();
    expect(hashToken(raw)).not.toBe(raw);
  });

  it('different raw tokens hash differently', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('S68 makeRawToken / makeOpaqueCode — crypto-secure, unique', () => {
  it('rawToken is a non-trivial url-safe string', () => {
    const t = makeRawToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(makeRawToken()).not.toBe(t);
  });

  it('opaqueCode is url-safe and distinct from rawToken', () => {
    const c = makeOpaqueCode();
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(makeOpaqueCode()).not.toBe(c);
  });
});

describe('S68 normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('S68 decideAcceptBranch — FR-W04a 4분기 결정 순수함수', () => {
  it('① UNREGISTERED — anonymous + invite email has no account', () => {
    expect(
      decideAcceptBranch({
        inviteEmail: 'new@acme.com',
        currentUserEmail: null,
        inviteEmailHasAccount: false,
      }),
    ).toBe('UNREGISTERED');
  });

  it('② SELF_MATCH — logged in, email matches invite', () => {
    expect(
      decideAcceptBranch({
        inviteEmail: 'me@acme.com',
        currentUserEmail: 'ME@acme.com',
        inviteEmailHasAccount: true,
      }),
    ).toBe('SELF_MATCH');
  });

  it('③ OTHER_ACCOUNT — logged in with a different email', () => {
    expect(
      decideAcceptBranch({
        inviteEmail: 'invitee@acme.com',
        currentUserEmail: 'someone-else@acme.com',
        inviteEmailHasAccount: false,
      }),
    ).toBe('OTHER_ACCOUNT');
  });

  it('anonymous but invite email already has an account → OTHER_ACCOUNT (login prompt)', () => {
    expect(
      decideAcceptBranch({
        inviteEmail: 'existing@acme.com',
        currentUserEmail: null,
        inviteEmailHasAccount: true,
      }),
    ).toBe('OTHER_ACCOUNT');
  });
});

describe('S68 isOverlyBroadDomain — 다중레이블 경고 감지 (S66 MEDIUM-2 이월)', () => {
  it('flags a bare TLD-level / 2-label host', () => {
    expect(isOverlyBroadDomain('com')).toBe(true);
    expect(isOverlyBroadDomain('acme.com')).toBe(true);
  });

  it('flags known 2-level public suffixes (e.g. co.uk)', () => {
    expect(isOverlyBroadDomain('co.uk')).toBe(true);
    expect(isOverlyBroadDomain('co.kr')).toBe(true);
  });

  it('does not flag a normal company host', () => {
    expect(isOverlyBroadDomain('acme.co.uk')).toBe(false);
    expect(isOverlyBroadDomain('mail.acme.com')).toBe(false);
  });

  it('normalizes case before judging', () => {
    expect(isOverlyBroadDomain('CO.UK')).toBe(true);
  });
});
