import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcceptInviteResponseSchema, CreateInviteRequestSchema, InviteSchema } from './workspace';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('S67 CreateInviteRequestSchema — temporary', () => {
  it('defaults temporary to false when omitted', () => {
    const parsed = CreateInviteRequestSchema.parse({});
    expect(parsed.temporary).toBe(false);
  });

  it('parses temporary=true', () => {
    const parsed = CreateInviteRequestSchema.parse({ temporary: true, maxUses: 5 });
    expect(parsed.temporary).toBe(true);
    expect(parsed.maxUses).toBe(5);
  });

  it('rejects a non-boolean temporary', () => {
    expect(() => CreateInviteRequestSchema.parse({ temporary: 'yes' })).toThrow();
  });
});

describe('S67 InviteSchema — management fields', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    code: 'Ab3Xk9Qp',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    createdById: '00000000-0000-4000-8000-000000000003',
    expiresAt: null,
    maxUses: null,
    usedCount: 0,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    url: 'http://localhost:45173/invite/Ab3Xk9Qp',
  };

  it('defaults temporary to false and round-trips management fields', () => {
    const parsed = InviteSchema.parse({
      ...base,
      usesRemaining: 4,
      active: true,
      createdBy: { id: base.createdById, username: 'owner' },
    });
    expect(parsed.temporary).toBe(false);
    expect(parsed.usesRemaining).toBe(4);
    expect(parsed.active).toBe(true);
    expect(parsed.createdBy?.username).toBe('owner');
  });

  it('accepts null usesRemaining (unlimited) and null createdBy', () => {
    const parsed = InviteSchema.parse({
      ...base,
      temporary: true,
      usesRemaining: null,
      active: true,
      createdBy: null,
    });
    expect(parsed.temporary).toBe(true);
    expect(parsed.usesRemaining).toBeNull();
    expect(parsed.createdBy).toBeNull();
  });
});

describe('S67 AcceptInviteResponseSchema — alreadyMember branch', () => {
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

  it('parses a fresh-join response (alreadyMember=false)', () => {
    const parsed = AcceptInviteResponseSchema.parse({ workspace, alreadyMember: false });
    expect(parsed.alreadyMember).toBe(false);
    expect(parsed.workspace.slug).toBe('acme');
  });

  it('parses an already-member response (alreadyMember=true)', () => {
    const parsed = AcceptInviteResponseSchema.parse({ workspace, alreadyMember: true });
    expect(parsed.alreadyMember).toBe(true);
  });

  it('requires the alreadyMember flag', () => {
    expect(() => AcceptInviteResponseSchema.parse({ workspace })).toThrow();
  });
});
