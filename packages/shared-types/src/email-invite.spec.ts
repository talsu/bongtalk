import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcceptEmailInviteResponseSchema,
  EMAIL_INVITE_MAX_BATCH,
  ExchangeEmailInviteResponseSchema,
  InviteByEmailRequestSchema,
  InviteByEmailResponseSchema,
  ListPendingInvitesResponseSchema,
  PendingInviteSchema,
  UpdatePendingInviteRequestSchema,
} from './email-invite';
import {
  isOverlyBroadDomain,
  TWO_LEVEL_PUBLIC_SUFFIXES,
  UpdateWorkspaceRequestSchema,
} from './workspace';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('S68 InviteByEmailRequestSchema — batch + role', () => {
  it('defaults role to MEMBER when omitted', () => {
    const parsed = InviteByEmailRequestSchema.parse({ emails: ['a@b.com'] });
    expect(parsed.role).toBe('MEMBER');
    expect(parsed.emails).toEqual(['a@b.com']);
  });

  it('accepts GUEST role', () => {
    const parsed = InviteByEmailRequestSchema.parse({ emails: ['a@b.com'], role: 'GUEST' });
    expect(parsed.role).toBe('GUEST');
  });

  it('rejects a non-MEMBER/GUEST role (no direct ADMIN invite)', () => {
    expect(() =>
      InviteByEmailRequestSchema.parse({ emails: ['a@b.com'], role: 'ADMIN' }),
    ).toThrow();
  });

  it('rejects an empty email list', () => {
    expect(() => InviteByEmailRequestSchema.parse({ emails: [] })).toThrow();
  });

  it(`rejects more than ${EMAIL_INVITE_MAX_BATCH} emails`, () => {
    const tooMany = Array.from({ length: EMAIL_INVITE_MAX_BATCH + 1 }, (_, i) => `u${i}@b.com`);
    expect(() => InviteByEmailRequestSchema.parse({ emails: tooMany })).toThrow();
  });

  it('rejects a malformed email', () => {
    expect(() => InviteByEmailRequestSchema.parse({ emails: ['not-an-email'] })).toThrow();
  });
});

describe('S68 InviteByEmailResponseSchema — partial success', () => {
  it('round-trips a mixed result set', () => {
    const parsed = InviteByEmailResponseSchema.parse({
      results: [
        { email: 'member@b.com', outcome: 'ADDED_MEMBER' },
        { email: 'new@b.com', outcome: 'PENDING' },
        { email: 'bad@b.com', outcome: 'FAILED', error: 'mail bounced' },
      ],
      sentCount: 1,
      addedCount: 1,
      failedCount: 1,
    });
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[2].error).toBe('mail bounced');
  });
});

describe('S68 ExchangeEmailInviteResponseSchema — opaque code only', () => {
  it('round-trips opaque exchange (no rawToken in shape)', () => {
    const parsed = ExchangeEmailInviteResponseSchema.parse({
      opaqueCode: 'opaque-abc',
      email: 'new@b.com',
      workspaceName: 'Acme',
      expiresAt: new Date().toISOString(),
    });
    expect(parsed.opaqueCode).toBe('opaque-abc');
    // the schema has no `token`/`rawToken` field — guard the leak invariant.
    expect('token' in parsed).toBe(false);
  });
});

describe('S68 PendingInviteSchema — no tokenHash leak', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    email: 'p@b.com',
    role: 'MEMBER' as const,
    expiresAt: new Date().toISOString(),
    lastSentAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    expired: false,
  };

  it('round-trips a pending invite row', () => {
    const parsed = PendingInviteSchema.parse({
      ...base,
      invitedBy: { id: base.workspaceId, username: 'admin' },
    });
    expect(parsed.email).toBe('p@b.com');
    expect(parsed.expired).toBe(false);
    expect('tokenHash' in parsed).toBe(false);
  });

  it('lists pending invites', () => {
    const parsed = ListPendingInvitesResponseSchema.parse({ pending: [base] });
    expect(parsed.pending).toHaveLength(1);
  });
});

describe('S68 UpdatePendingInviteRequestSchema — EXTEND/RESEND', () => {
  it('accepts EXTEND and RESEND', () => {
    expect(UpdatePendingInviteRequestSchema.parse({ action: 'EXTEND' }).action).toBe('EXTEND');
    expect(UpdatePendingInviteRequestSchema.parse({ action: 'RESEND' }).action).toBe('RESEND');
  });

  it('rejects an unknown action', () => {
    expect(() => UpdatePendingInviteRequestSchema.parse({ action: 'CANCEL' })).toThrow();
  });
});

describe('S68 UpdateWorkspaceRequestSchema — emailDomains (FR-W05 Fork C)', () => {
  it('accepts an emailDomains array on the existing PATCH body', () => {
    const parsed = UpdateWorkspaceRequestSchema.parse({ emailDomains: ['acme.com', 'acme.io'] });
    expect(parsed.emailDomains).toEqual(['acme.com', 'acme.io']);
  });

  it('accepts an empty emailDomains array (clear the whitelist)', () => {
    const parsed = UpdateWorkspaceRequestSchema.parse({ emailDomains: [] });
    expect(parsed.emailDomains).toEqual([]);
  });

  it('omits emailDomains when not provided (no change)', () => {
    const parsed = UpdateWorkspaceRequestSchema.parse({ name: 'New name' });
    expect(parsed.emailDomains).toBeUndefined();
  });

  it('normalizes an uppercase host to lowercase (S68 LOW-3 — no 400 friction)', () => {
    const parsed = UpdateWorkspaceRequestSchema.parse({ emailDomains: ['Acme.COM', ' beta.IO '] });
    expect(parsed.emailDomains).toEqual(['acme.com', 'beta.io']);
  });

  it('still rejects a malformed host after normalization', () => {
    expect(() => UpdateWorkspaceRequestSchema.parse({ emailDomains: ['not a host'] })).toThrow();
  });
});

describe('S68 isOverlyBroadDomain — shared 단일 출처 (reviewer MN2)', () => {
  it('flags a bare TLD-level / 2-label host', () => {
    expect(isOverlyBroadDomain('com')).toBe(true);
    expect(isOverlyBroadDomain('acme.com')).toBe(true);
  });

  it('flags known 2-level public suffixes (e.g. co.uk)', () => {
    expect(isOverlyBroadDomain('co.uk')).toBe(true);
    expect(isOverlyBroadDomain('co.kr')).toBe(true);
    expect(TWO_LEVEL_PUBLIC_SUFFIXES.has('co.uk')).toBe(true);
  });

  it('does not flag a normal company host', () => {
    expect(isOverlyBroadDomain('acme.co.uk')).toBe(false);
    expect(isOverlyBroadDomain('mail.acme.com')).toBe(false);
  });

  it('normalizes case + whitespace before judging', () => {
    expect(isOverlyBroadDomain(' CO.UK ')).toBe(true);
  });
});

describe('S68 AcceptEmailInviteResponseSchema', () => {
  const workspace = {
    id: '00000000-0000-4000-8000-000000000010',
    name: 'Acme',
    slug: 'acme',
    description: null,
    iconUrl: null,
    ownerId: '00000000-0000-4000-8000-000000000011',
    category: null,
    createdAt: new Date().toISOString(),
    deletedAt: null,
    deleteAt: null,
  };

  it('parses a fresh-join accept response', () => {
    const parsed = AcceptEmailInviteResponseSchema.parse({ workspace, alreadyMember: false });
    expect(parsed.alreadyMember).toBe(false);
    expect(parsed.workspace.slug).toBe('acme');
  });
});
