import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TokenService } from '../../../src/auth/services/token.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import { SESSION_COMPROMISED } from '../../../src/auth/events/session-compromised.event';

type RefreshRow = {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  parentId: string | null;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedAt: Date | null;
  createdAt: Date;
};

function makePrisma() {
  const rows = new Map<string, RefreshRow>();
  return {
    rows,
    refreshToken: {
      create: vi.fn(async ({ data }: { data: Omit<RefreshRow, 'id' | 'createdAt' | 'revokedAt' | 'replacedAt'> & Partial<RefreshRow> }) => {
        const row: RefreshRow = {
          ...data,
          id: crypto.randomUUID(),
          createdAt: new Date(),
          revokedAt: null,
          replacedAt: null,
          parentId: data.parentId ?? null,
          userAgent: data.userAgent ?? null,
          ip: data.ip ?? null,
        } as RefreshRow;
        rows.set(row.tokenHash, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        return rows.get(where.tokenHash) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RefreshRow> }) => {
        for (const row of rows.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
        throw new Error('not found');
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { familyId: string; revokedAt: null }; data: Partial<RefreshRow> }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (row.familyId === where.familyId && row.revokedAt === null) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
}

function makeService(emitter?: EventEmitter2) {
  process.env.JWT_ACCESS_SECRET = 'test-secret-at-least-32-characters-long!!';
  process.env.JWT_ISSUER = 'qufox';
  process.env.JWT_AUDIENCE = 'qufox-web';
  process.env.ACCESS_TOKEN_TTL = '900';
  process.env.REFRESH_TOKEN_TTL = '604800';
  const jwt = new JwtService({
    secret: process.env.JWT_ACCESS_SECRET,
    signOptions: { issuer: 'qufox', audience: 'qufox-web' },
  });
  const prisma = makePrisma();
  const em = emitter ?? new EventEmitter2();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new TokenService(jwt, prisma as any, em);
  return { svc, prisma, em };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('TokenService access tokens', () => {
  it('signs and verifies an access token', async () => {
    const { svc } = makeService();
    const token = svc.signAccess('user-1');
    const payload = await svc.verifyAccess(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.type).toBe('access');
  });

  it('rejects a tampered access token', async () => {
    const { svc } = makeService();
    const token = svc.signAccess('user-1');
    const bad = token.slice(0, -4) + 'abcd';
    await expect(svc.verifyAccess(bad)).rejects.toBeInstanceOf(DomainError);
  });
});

describe('TokenService refresh rotation', () => {
  it('issues a refresh, then rotates to a new one keeping familyId', async () => {
    const { svc } = makeService();
    const first = await svc.issueRefreshForNewSession('u-1');
    const rotated = await svc.rotate(first.raw);
    expect(rotated.familyId).toBe(first.familyId);
    expect(rotated.raw).not.toBe(first.raw);
  });

  it('reuse of an already rotated refresh token → family revoked + event emitted', async () => {
    const events: unknown[] = [];
    const em = new EventEmitter2();
    em.on(SESSION_COMPROMISED, (e) => events.push(e));
    const { svc, prisma } = makeService(em);

    const first = await svc.issueRefreshForNewSession('u-1');
    await svc.rotate(first.raw);
    // Attacker plays back the old (now-revoked) token.
    await expect(svc.rotate(first.raw)).rejects.toMatchObject({
      code: ErrorCode.AUTH_SESSION_COMPROMISED,
    });
    expect(events).toHaveLength(1);
    // All tokens in the family must be revoked now.
    for (const row of prisma.rows.values()) {
      if (row.familyId === first.familyId) {
        expect(row.revokedAt).not.toBeNull();
      }
    }
  });

  it('rejects an unknown refresh token', async () => {
    const { svc } = makeService();
    await expect(svc.rotate('totally-not-real')).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });

  it('rejects an expired refresh token', async () => {
    const { svc, prisma } = makeService();
    const first = await svc.issueRefreshForNewSession('u-1');
    // force expiry in the in-memory row
    for (const row of prisma.rows.values()) {
      row.expiresAt = new Date(Date.now() - 1000);
    }
    await expect(svc.rotate(first.raw)).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });
});
