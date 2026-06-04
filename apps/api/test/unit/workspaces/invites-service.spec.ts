import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { InvitesService } from '../../../src/workspaces/invites/invites.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { ModerationService } from '../../../src/workspaces/moderation/moderation.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORKSPACE = {
  id: WS,
  name: 'Acme',
  slug: 'acme',
  description: null,
  iconUrl: null,
  ownerId: ACTOR,
  category: null,
  createdAt: new Date(),
  deletedAt: null,
  deleteAt: null,
};

function makeOutbox(): OutboxService {
  return { record: vi.fn().mockResolvedValue('outbox-id') } as unknown as OutboxService;
}

function makeModeration(banned = false): ModerationService {
  return { isBanned: vi.fn().mockResolvedValue(banned) } as unknown as ModerationService;
}

async function expectDomainError(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toMatchObject({ code });
}

describe('S67 InvitesService — makeCode (Fork B: 8-char alphanumeric)', () => {
  it('생성 코드는 8자이며 혼동 문자(0/O/1/l/I) 없는 alphanumeric 만 사용합니다', async () => {
    const created: string[] = [];
    const prisma = {
      invite: {
        create: vi.fn(async ({ data }: { data: { code: string } }) => {
          created.push(data.code);
          return { id: 'inv', ...data };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());

    for (let i = 0; i < 50; i++) {
      // outbox.record 가 tx 에서 호출되므로 prisma 에 invite.create 만 있으면 충분.
      await svc.create(WS, ACTOR, { temporary: false });
    }
    for (const code of created) {
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[A-Za-z2-9]{8}$/);
      expect(code).not.toMatch(/[0O1lI]/);
    }
  });

  it('code @unique 충돌(P2002) 시 재시도해 결국 성공합니다', async () => {
    let attempt = 0;
    const prisma = {
      invite: {
        create: vi.fn(async ({ data }: { data: { code: string } }) => {
          attempt += 1;
          if (attempt === 1) {
            throw new Prisma.PrismaClientKnownRequestError('dup', {
              code: 'P2002',
              clientVersion: 'x',
            });
          }
          return { id: 'inv', ...data };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());

    const inv = await svc.create(WS, ACTOR, { temporary: false });
    expect(attempt).toBe(2);
    expect((inv as { code: string }).code).toMatch(/^[A-Za-z2-9]{8}$/);
  });
});

describe('S67 InvitesService — create stores temporary', () => {
  it('temporary=true 를 그대로 저장합니다', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'inv',
      ...data,
    }));
    const prisma = {
      invite: { create },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());

    await svc.create(WS, ACTOR, { temporary: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ temporary: true }) }),
    );
  });
});

describe('S67 InvitesService — list role filter (FR-W17)', () => {
  const rows = [
    {
      id: 'i1',
      code: 'AAAAAAAA',
      workspaceId: WS,
      createdById: ACTOR,
      expiresAt: null,
      maxUses: 5,
      usedCount: 2,
      revokedAt: null,
      temporary: false,
      createdAt: new Date(),
      createdBy: { id: ACTOR, username: 'me' },
    },
  ];

  function makeSvc() {
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = { invite: { findMany } } as unknown as PrismaService;
    return { svc: new InvitesService(prisma, makeOutbox(), makeModeration()), findMany };
  }

  it('ADMIN 은 createdById 필터 없이 전체를 조회합니다', async () => {
    const { svc, findMany } = makeSvc();
    await svc.list(WS, ACTOR, 'ADMIN');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS } }));
  });

  it('MODERATOR 는 본인 생성분(createdById=actor)만 조회합니다', async () => {
    const { svc, findMany } = makeSvc();
    await svc.list(WS, ACTOR, 'MODERATOR');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, createdById: ACTOR } }),
    );
  });

  it('usesRemaining/active 파생값을 계산해 내려보냅니다', async () => {
    const { svc } = makeSvc();
    const out = await svc.list(WS, ACTOR, 'ADMIN');
    expect(out[0].usesRemaining).toBe(3); // maxUses 5 - usedCount 2
    expect(out[0].active).toBe(true);
  });
});

describe('S67 InvitesService — revoke/hardDelete MODERATOR scope (FR-W17)', () => {
  it('MODERATOR revoke 는 where 에 createdById=actor 를 강제합니다', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      invite: { updateMany },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());
    await svc.revoke(WS, 'i1', ACTOR, 'MODERATOR');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: ACTOR, workspaceId: WS }),
      }),
    );
  });

  it('MODERATOR 가 타인 링크를 revoke 하면 매칭 0건 → INVITE_NOT_FOUND', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      invite: { updateMany },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());
    await expectDomainError(svc.revoke(WS, 'i1', OTHER, 'MODERATOR'), ErrorCode.INVITE_NOT_FOUND);
  });

  it('ADMIN hardDelete 는 createdById 필터 없이 deleteMany 합니다', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { invite: { deleteMany } } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());
    await svc.hardDelete(WS, 'i1', ACTOR, 'ADMIN');
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'i1', workspaceId: WS } });
  });

  it('hardDelete 매칭 0건 → INVITE_NOT_FOUND', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { invite: { deleteMany } } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());
    await expectDomainError(
      svc.hardDelete(WS, 'i1', ACTOR, 'MODERATOR'),
      ErrorCode.INVITE_NOT_FOUND,
    );
  });
});

describe('S67 InvitesService — accept already-member (FR-W03 멱등 200)', () => {
  it('이미 멤버면 throw 대신 { workspace, alreadyMember:true } 를 반환합니다', async () => {
    const prisma = {
      invite: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'inv',
          workspaceId: WS,
          revokedAt: null,
          expiresAt: null,
          maxUses: null,
          temporary: false,
          workspace: { emailDomains: [] },
        }),
      },
      workspaceMember: {
        findUnique: vi.fn().mockResolvedValue({ workspaceId: WS, userId: ACTOR }),
      },
      workspace: { findUnique: vi.fn().mockResolvedValue(WORKSPACE) },
      $executeRawUnsafe: vi.fn(),
    } as unknown as PrismaService;
    const svc = new InvitesService(prisma, makeOutbox(), makeModeration());

    const res = await svc.accept('CODE1234', ACTOR, {
      emailVerified: true,
      userEmail: 'a@acme.dev',
    });
    expect(res.alreadyMember).toBe(true);
    expect(res.workspace.id).toBe(WS);
    // 좌석(CAS) 을 소모하지 않습니다.
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('S67 InvitesService — accept records isTemporary (FR-W03)', () => {
  function makeAcceptPrisma(temporary: boolean) {
    const memberCreate = vi.fn().mockResolvedValue(undefined);
    const tx = {
      workspaceMember: { create: memberCreate },
      role: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'r-member', name: 'MEMBER', isSystem: true, position: 200 }]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      memberRole: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const outbox = { record: vi.fn().mockResolvedValue('o') } as unknown as OutboxService;
    const prisma = {
      invite: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'inv',
          workspaceId: WS,
          revokedAt: null,
          expiresAt: null,
          maxUses: null,
          temporary,
          workspace: { emailDomains: [] },
        }),
      },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      workspace: { findUnique: vi.fn().mockResolvedValue(WORKSPACE) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    return { svc: new InvitesService(prisma, outbox, makeModeration()), memberCreate };
  }

  it('temporary=true 초대 수락 → WorkspaceMember.isTemporary=true', async () => {
    const { svc, memberCreate } = makeAcceptPrisma(true);
    const res = await svc.accept('CODE1234', ACTOR, {
      emailVerified: true,
      userEmail: 'a@acme.dev',
    });
    expect(res.alreadyMember).toBe(false);
    expect(memberCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isTemporary: true }) }),
    );
  });

  it('temporary=false 초대 수락 → WorkspaceMember.isTemporary=false', async () => {
    const { svc, memberCreate } = makeAcceptPrisma(false);
    await svc.accept('CODE1234', ACTOR, { emailVerified: true, userEmail: 'a@acme.dev' });
    expect(memberCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isTemporary: false }) }),
    );
  });
});
