import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { InvitesService } from '../../../src/workspaces/invites/invites.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { ModerationService } from '../../../src/workspaces/moderation/moderation.service';
import type { AuditService } from '../../../src/common/audit/audit.service';
import type { IpSoftBlockService } from '../../../src/workspaces/moderation/ip-soft-block.service';
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

function makeAudit(): AuditService {
  return { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

// S72 (D13 / FR-W22): IP soft-block 스텁 — 이 스펙들은 차단 IP 가 없는 정상 수락을 다루므로
// assertNotIpBlocked 는 항상 무차단(ipHash=null) 으로 통과시킨다.
function makeIpSoftBlock(): IpSoftBlockService {
  return {
    assertNotIpBlocked: vi.fn().mockResolvedValue({ ipHash: null }),
  } as unknown as IpSoftBlockService;
}

// 072 백로그 S-C 리뷰(LOW): preview 가 iconUrl(storageKey)을 presignIconUrl 로 변환하므로
// WorkspacesService 스텁을 주입한다. 패스-스루(키 그대로 반환 — 테스트 iconUrl 은 null).
function makeWorkspaces(): import('../../../src/workspaces/workspaces.service').WorkspacesService {
  return {
    presignIconUrl: vi.fn(async (k: string | null) => k),
  } as unknown as import('../../../src/workspaces/workspaces.service').WorkspacesService;
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
    const svc = new InvitesService(
      prisma,
      makeOutbox(),
      makeModeration(),
      makeAudit(),
      makeIpSoftBlock(),
      makeWorkspaces(),
    );

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
    const svc = new InvitesService(
      prisma,
      makeOutbox(),
      makeModeration(),
      makeAudit(),
      makeIpSoftBlock(),
      makeWorkspaces(),
    );

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
    const svc = new InvitesService(
      prisma,
      makeOutbox(),
      makeModeration(),
      makeAudit(),
      makeIpSoftBlock(),
      makeWorkspaces(),
    );

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
    return {
      svc: new InvitesService(
        prisma,
        makeOutbox(),
        makeModeration(),
        makeAudit(),
        makeIpSoftBlock(),
        makeWorkspaces(),
      ),
      findMany,
    };
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
    const svc = new InvitesService(
      prisma,
      makeOutbox(),
      makeModeration(),
      makeAudit(),
      makeIpSoftBlock(),
      makeWorkspaces(),
    );
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
    const svc = new InvitesService(
      prisma,
      makeOutbox(),
      makeModeration(),
      makeAudit(),
      makeIpSoftBlock(),
      makeWorkspaces(),
    );
    await expectDomainError(svc.revoke(WS, 'i1', OTHER, 'MODERATOR'), ErrorCode.INVITE_NOT_FOUND);
  });

  // S67 fix-forward (security MEDIUM + reviewer #5): hardDelete 는 $transaction 으로
  // findFirst(권한 where) → delete → outbox(INVITE_DELETED) → audit(INVITE_DELETED) 를
  // 한 commit 으로 묶는다.
  function makeHardDeletePrisma(found: { id: string; code: string } | null, role: string) {
    const findFirst = vi.fn().mockResolvedValue(found);
    const del = vi.fn().mockResolvedValue(undefined);
    const tx = { invite: { findFirst, delete: del } };
    const prisma = {
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = makeOutbox();
    const audit = makeAudit();
    return {
      svc: new InvitesService(
        prisma,
        outbox,
        makeModeration(),
        audit,
        makeIpSoftBlock(),
        makeWorkspaces(),
      ),
      findFirst,
      del,
      outbox,
      audit,
      role,
    };
  }

  it('ADMIN hardDelete 는 createdById 필터 없이 행 조회 후 삭제합니다', async () => {
    const { svc, findFirst, del } = makeHardDeletePrisma({ id: 'i1', code: 'AAAAAAAA' }, 'ADMIN');
    await svc.hardDelete(WS, 'i1', ACTOR, 'ADMIN');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'i1', workspaceId: WS } }),
    );
    expect(del).toHaveBeenCalledWith({ where: { id: 'i1' } });
  });

  it('MODERATOR hardDelete 는 where 에 createdById=actor 를 강제합니다', async () => {
    const { svc, findFirst } = makeHardDeletePrisma({ id: 'i1', code: 'BBBBBBBB' }, 'MODERATOR');
    await svc.hardDelete(WS, 'i1', ACTOR, 'MODERATOR');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: ACTOR, workspaceId: WS }),
      }),
    );
  });

  it('hardDelete 는 INVITE_DELETED outbox + audit 를 같은 tx 로 기록합니다', async () => {
    const { svc, outbox, audit } = makeHardDeletePrisma({ id: 'i1', code: 'CCCCCCCC' }, 'ADMIN');
    await svc.hardDelete(WS, 'i1', ACTOR, 'ADMIN');
    expect(outbox.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'workspace.invite.deleted',
        aggregateType: 'invite',
        aggregateId: 'i1',
        payload: expect.objectContaining({ workspaceId: WS, inviteId: 'i1', actorId: ACTOR }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorId: ACTOR,
        action: 'INVITE_DELETED',
        targetId: 'i1',
        details: expect.objectContaining({ code: 'CCCCCCCC' }),
      }),
      expect.anything(),
    );
  });

  it('hardDelete 매칭 0건(findFirst null) → INVITE_NOT_FOUND, 삭제/기록 없음', async () => {
    const { svc, del, outbox, audit } = makeHardDeletePrisma(null, 'MODERATOR');
    await expectDomainError(
      svc.hardDelete(WS, 'i1', ACTOR, 'MODERATOR'),
      ErrorCode.INVITE_NOT_FOUND,
    );
    expect(del).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('S67 InvitesService — accept already-member (FR-W03 멱등 200)', () => {
  it('이미 멤버면 throw 대신 { workspace, alreadyMember:true } 를 반환합니다', async () => {
    const wsFindUnique = vi.fn().mockResolvedValue(WORKSPACE);
    const prisma = {
      invite: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'inv',
          workspaceId: WS,
          revokedAt: null,
          expiresAt: null,
          maxUses: null,
          temporary: false,
          // S67 fix-forward (perf #2): accept 가 재조회 없이 existing.workspace 를 재사용하므로
          // invite.findUnique 의 joined workspace 가 응답 shape(id/name/slug…)를 담아야 한다.
          workspace: { ...WORKSPACE, emailDomains: [] },
        }),
      },
      workspaceMember: {
        findUnique: vi.fn().mockResolvedValue({ workspaceId: WS, userId: ACTOR }),
      },
      workspace: { findUnique: wsFindUnique },
      $executeRawUnsafe: vi.fn(),
    } as unknown as PrismaService;
    const svc = new InvitesService(
      prisma,
      makeOutbox(),
      makeModeration(),
      makeAudit(),
      makeIpSoftBlock(),
      makeWorkspaces(),
    );

    const res = await svc.accept('CODE1234', ACTOR, {
      emailVerified: true,
      userEmail: 'a@acme.dev',
    });
    expect(res.alreadyMember).toBe(true);
    expect(res.workspace.id).toBe(WS);
    // 좌석(CAS) 을 소모하지 않습니다.
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    // S67 fix-forward (perf #2): workspace 재조회를 제거했으므로 호출되지 않습니다.
    expect(wsFindUnique).not.toHaveBeenCalled();
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
          // S67 fix-forward (perf #2): joined workspace 가 응답 shape 를 담는다(재조회 제거).
          workspace: { ...WORKSPACE, emailDomains: [] },
        }),
      },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      workspace: { findUnique: vi.fn().mockResolvedValue(WORKSPACE) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    return {
      svc: new InvitesService(
        prisma,
        outbox,
        makeModeration(),
        makeAudit(),
        makeIpSoftBlock(),
        makeWorkspaces(),
      ),
      memberCreate,
    };
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

// S67 fix-forward (reviewer #3): accept 멤버 INSERT P2002 처리는 WorkspaceMember 복합 PK
// 충돌일 때만 좌석 환불 + alreadyMember 멱등 성공으로 흡수하고, 다른 unique 제약 충돌은
// rethrow 해 오탐(좌석 오환불·실패 은폐)을 막는다.
describe('S67 InvitesService — accept P2002 target guard (reviewer #3)', () => {
  function makeP2002Prisma(target: string | string[]) {
    const memberCreate = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target },
      }),
    );
    const tx = { workspaceMember: { create: memberCreate } };
    const refund = vi.fn().mockResolvedValue(1);
    const cas = vi.fn().mockResolvedValue(1);
    // 첫 호출(CAS)=1, 이후 호출(refund)=1 — 동일 mock 이 둘 다 처리한다.
    const exec = vi
      .fn()
      .mockImplementation((sql: string) => (sql.includes('+ 1') ? cas() : refund()));
    const prisma = {
      invite: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'inv',
          workspaceId: WS,
          revokedAt: null,
          expiresAt: null,
          maxUses: null,
          temporary: false,
          workspace: { ...WORKSPACE, emailDomains: [] },
        }),
      },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      $executeRawUnsafe: exec,
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    return {
      svc: new InvitesService(
        prisma,
        makeOutbox(),
        makeModeration(),
        makeAudit(),
        makeIpSoftBlock(),
        makeWorkspaces(),
      ),
      refund,
    };
  }

  it('WorkspaceMember PK 충돌(제약명 문자열) → 좌석 환불 + alreadyMember:true', async () => {
    const { svc, refund } = makeP2002Prisma('WorkspaceMember_pkey');
    const res = await svc.accept('CODE1234', ACTOR, {
      emailVerified: true,
      userEmail: 'a@acme.dev',
    });
    expect(res.alreadyMember).toBe(true);
    expect(refund).toHaveBeenCalled();
  });

  it('WorkspaceMember PK 충돌(필드 배열) → 좌석 환불 + alreadyMember:true', async () => {
    const { svc, refund } = makeP2002Prisma(['workspaceId', 'userId']);
    const res = await svc.accept('CODE1234', ACTOR, {
      emailVerified: true,
      userEmail: 'a@acme.dev',
    });
    expect(res.alreadyMember).toBe(true);
    expect(refund).toHaveBeenCalled();
  });

  it('다른 unique 제약 P2002(오탐) → rethrow, 좌석 환불 안 함', async () => {
    const { svc, refund } = makeP2002Prisma('SomeOther_unique');
    await expect(
      svc.accept('CODE1234', ACTOR, { emailVerified: true, userEmail: 'a@acme.dev' }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(refund).not.toHaveBeenCalled();
  });
});
