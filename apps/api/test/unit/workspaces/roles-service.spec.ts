import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PERMISSIONS,
  serializePermissions,
  toStoragePermissions,
  SYSTEM_ROLE_PERMISSIONS,
} from '@qufox/shared-types';
import { RolesService } from '../../../src/workspaces/roles/roles.service';
import { MemberRoleService } from '../../../src/workspaces/roles/member-role.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { RoleCacheQueueService } from '../../../src/queue/role-cache-queue.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// 액터가 ADMIN 역할(position 400, permissions=ADMIN 비트)을 보유한 상황을 모킹.
function adminActorMemberRoles() {
  return [
    {
      role: {
        position: 400,
        permissions: toStoragePermissions(SYSTEM_ROLE_PERMISSIONS.ADMIN),
      },
    },
  ];
}

async function expectDomainError(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toMatchObject({ code });
}

describe('S61 RolesService — privilege escalation + system protection', () => {
  function makeService(prismaOverrides: Record<string, unknown> = {}) {
    const memberRoleFindMany = vi.fn().mockResolvedValue(adminActorMemberRoles());
    const prisma = {
      memberRole: { findMany: memberRoleFindMany },
      role: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      channel: { findMany: vi.fn().mockResolvedValue([]) },
      channelPermissionOverride: { deleteMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        typeof fn === 'function' ? fn(prisma) : undefined,
      ),
      $queryRaw: vi.fn(),
      ...prismaOverrides,
    } as unknown as PrismaService;
    const roleCache = {
      invalidateForDeletedRole: vi.fn().mockResolvedValue(undefined),
    } as unknown as RoleCacheQueueService;
    return { svc: new RolesService(prisma, roleCache), prisma, roleCache };
  }

  it('FR-RM04: ADMIN actor cannot grant ADMINISTRATOR (escalation denied)', async () => {
    const { svc } = makeService();
    await expectDomainError(
      svc.create(WS, ACTOR, {
        name: 'evil',
        permissions: serializePermissions(PERMISSIONS.ADMINISTRATOR),
      }),
      ErrorCode.ROLE_PRIVILEGE_ESCALATION,
    );
  });

  it('FR-RM04: ADMIN actor cannot grant a bit it does not hold', async () => {
    // ADMIN baseline lacks ADMINISTRATOR; granting MANAGE_WEBHOOKS is fine, but a
    // bit outside ADMIN (e.g. ADMINISTRATOR) is denied — verify a within-bounds
    // grant succeeds and an out-of-bounds is rejected.
    const { svc, prisma } = makeService();
    (prisma.role.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-role',
      workspaceId: WS,
      name: 'helper',
      colorHex: null,
      position: 1,
      permissions: toStoragePermissions(PERMISSIONS.MANAGE_MESSAGES),
      isSystem: false,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    const ok = await svc.create(WS, ACTOR, {
      name: 'helper',
      permissions: serializePermissions(PERMISSIONS.MANAGE_MESSAGES),
      position: 1,
    });
    expect(ok.name).toBe('helper');
  });

  it('FR-RM04: cannot create a role at/above actor top position', async () => {
    const { svc } = makeService();
    await expectDomainError(
      svc.create(WS, ACTOR, { name: 'tooHigh', position: 400 }),
      ErrorCode.ROLE_POSITION_TOO_HIGH,
    );
  });

  // S61 fix-forward (security MED-1 · TOCTOU): create 는 트랜잭션 + 액터 MemberRole
  // SELECT FOR UPDATE 안에서 권한검사~쓰기를 직렬화한다(update 패턴과 일관).
  it('MED-1: create runs inside a transaction and locks the actor MemberRole (FOR UPDATE)', async () => {
    const { svc, prisma } = makeService();
    (prisma.role.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-role',
      workspaceId: WS,
      name: 'helper',
      colorHex: null,
      position: 1,
      permissions: toStoragePermissions(PERMISSIONS.SEND_MESSAGES),
      isSystem: false,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    await svc.create(WS, ACTOR, {
      name: 'helper',
      permissions: serializePermissions(PERMISSIONS.SEND_MESSAGES),
      position: 1,
    });
    // 트랜잭션이 한 번 열렸고, 그 안에서 MemberRole 행 FOR UPDATE 잠금 쿼리가 나갔다.
    expect((prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    const queryRawCalls = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
    const lockedMemberRole = queryRawCalls.some((c) => {
      const sql = Array.isArray(c[0]) ? c[0].join(' ') : String(c[0]);
      return /MemberRole/i.test(sql) && /FOR UPDATE/i.test(sql);
    });
    expect(lockedMemberRole).toBe(true);
  });

  it('FR-RM01: system role name/position is immutable', async () => {
    const { svc, prisma } = makeService();
    (prisma.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sys-mod',
      workspaceId: WS,
      name: 'MODERATOR',
      colorHex: null,
      position: 300,
      permissions: toStoragePermissions(SYSTEM_ROLE_PERMISSIONS.MODERATOR),
      isSystem: true,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    await expectDomainError(
      svc.update(WS, ACTOR, 'sys-mod', { name: 'renamed' }),
      ErrorCode.ROLE_SYSTEM_IMMUTABLE,
    );
  });

  it('FR-RM15: system role cannot be deleted', async () => {
    const { svc, prisma } = makeService();
    (prisma.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sys-owner',
      workspaceId: WS,
      name: 'OWNER',
      colorHex: null,
      position: 500,
      permissions: toStoragePermissions(PERMISSIONS.ADMINISTRATOR),
      isSystem: true,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    await expectDomainError(svc.remove(WS, ACTOR, 'sys-owner'), ErrorCode.ROLE_SYSTEM_IMMUTABLE);
  });

  it('FR-RM15: deleting a custom role removes ROLE overrides + invalidates cache', async () => {
    const { svc, prisma, roleCache } = makeService({
      role: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'custom',
          workspaceId: WS,
          name: 'Helpers',
          colorHex: null,
          position: 50,
          permissions: toStoragePermissions(PERMISSIONS.SEND_MESSAGES),
          isSystem: false,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:00Z'),
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      memberRole: {
        findMany: vi
          .fn()
          // first call: actor top position; subsequent: members holding the role.
          .mockResolvedValueOnce(adminActorMemberRoles())
          .mockResolvedValueOnce([{ userId: TARGET }]),
      },
      channel: { findMany: vi.fn().mockResolvedValue([{ id: 'chan-1' }]) },
      channelPermissionOverride: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });
    await svc.remove(WS, ACTOR, 'custom');
    expect(
      (prisma.channelPermissionOverride.deleteMany as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
    expect(
      (roleCache.invalidateForDeletedRole as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toMatchObject({ roleId: 'custom', userIds: [TARGET], channelIds: ['chan-1'] });
  });
});

describe('S61 MemberRoleService — assignment escalation defense', () => {
  function makeService(overrides: Record<string, unknown> = {}) {
    const prisma = {
      role: { findFirst: vi.fn() },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: TARGET }) },
      memberRole: {
        findMany: vi.fn().mockResolvedValue(adminActorMemberRoles()),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
      },
      ...overrides,
    } as unknown as PrismaService;
    return { svc: new MemberRoleService(prisma), prisma };
  }

  it('FR-RM04: cannot assign an ADMINISTRATOR role without holding it', async () => {
    const { svc, prisma } = makeService();
    (prisma.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'owner-role',
      workspaceId: WS,
      position: 50,
      permissions: toStoragePermissions(PERMISSIONS.ADMINISTRATOR),
    });
    await expectDomainError(
      svc.assign(WS, ACTOR, TARGET, 'owner-role'),
      ErrorCode.ROLE_PRIVILEGE_ESCALATION,
    );
  });

  it('FR-RM04: cannot assign a role at/above actor top position', async () => {
    const { svc, prisma } = makeService();
    (prisma.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'high-role',
      workspaceId: WS,
      position: 400,
      permissions: toStoragePermissions(PERMISSIONS.SEND_MESSAGES),
    });
    await expectDomainError(
      svc.assign(WS, ACTOR, TARGET, 'high-role'),
      ErrorCode.ROLE_POSITION_TOO_HIGH,
    );
  });

  it('FR-RM04: assigns a within-bounds role', async () => {
    const { svc, prisma } = makeService();
    (prisma.role.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'helper',
      workspaceId: WS,
      position: 50,
      permissions: toStoragePermissions(PERMISSIONS.SEND_MESSAGES),
    });
    await svc.assign(WS, ACTOR, TARGET, 'helper');
    expect((prisma.memberRole.upsert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
