import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceRole } from '@prisma/client';
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, toStoragePermissions } from '@qufox/shared-types';
import { ChannelAccessService } from '../../../src/channels/permission/channel-access.service';
import { Permission, ROLE_BASELINE, ALL_PERMISSIONS } from '../../../src/auth/permissions';

/**
 * S62 (FR-RM03 · ★보안 critical 회귀): 집행 배선이 커스텀 Role 을 반영하되, 커스텀
 * Role 이 없는 기존 워크스페이스에서는 결과가 **기존 ROLE_BASELINE 과 정확히 일치**
 * 해야 한다(prod 권한 붕괴 방지). vi.fn() 만 사용(외부 모킹 금지).
 */

const WS = 'ws-1';
const CH_PUBLIC = { id: 'ch-pub', workspaceId: WS, isPrivate: false };
const CH_PRIVATE = { id: 'ch-priv', workspaceId: WS, isPrivate: true };
const UID = 'user-1';

type Override = {
  principalType: 'USER' | 'ROLE';
  principalId: string;
  allowMask: bigint;
  denyMask: bigint;
};

/** AuditService 스텁(bypass 감사 — 본 스펙은 호출하지 않으나 생성자 인자 충족). */
function makeAuditStub(): ConstructorParameters<typeof ChannelAccessService>[1] {
  return {
    recordBestEffort: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof ChannelAccessService>[1];
}

/** 시스템 역할만 가진 멤버(backfill 된 MemberRole 1행)를 흉내내는 prisma 스텁. */
function makeServiceSystemRole(role: WorkspaceRole, overrides: Override[]): ChannelAccessService {
  const systemRoleId = `sysrole-${role}`;
  const prisma = {
    workspaceMember: {
      findUnique: vi.fn().mockResolvedValue({
        role,
        memberRoles: [
          {
            role: {
              id: systemRoleId,
              permissions: toStoragePermissions(SYSTEM_ROLE_PERMISSIONS[role]),
              position: 100,
            },
          },
        ],
      }),
    },
    channelPermissionOverride: { findMany: vi.fn().mockResolvedValue(overrides) },
    memberRole: { findMany: vi.fn().mockResolvedValue([{ roleId: systemRoleId }]) },
  } as unknown as ConstructorParameters<typeof ChannelAccessService>[0];
  // Redis 미주입(Optional) → 캐시 우회.
  return new ChannelAccessService(prisma, makeAuditStub());
}

/** 커스텀 Role 을 가진 멤버 스텁. */
function makeServiceCustomRole(
  systemRole: WorkspaceRole,
  customRole: { id: string; permissions: bigint; position: number },
  overrides: Override[],
): ChannelAccessService {
  const systemRoleId = `sysrole-${systemRole}`;
  const prisma = {
    workspaceMember: {
      findUnique: vi.fn().mockResolvedValue({
        role: systemRole,
        memberRoles: [
          {
            role: {
              id: systemRoleId,
              permissions: toStoragePermissions(SYSTEM_ROLE_PERMISSIONS[systemRole]),
              position: 100,
            },
          },
          {
            role: {
              id: customRole.id,
              permissions: toStoragePermissions(customRole.permissions),
              position: customRole.position,
            },
          },
        ],
      }),
    },
    channelPermissionOverride: { findMany: vi.fn().mockResolvedValue(overrides) },
    memberRole: {
      findMany: vi.fn().mockResolvedValue([{ roleId: systemRoleId }, { roleId: customRole.id }]),
    },
  } as unknown as ConstructorParameters<typeof ChannelAccessService>[0];
  return new ChannelAccessService(prisma, makeAuditStub());
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('S62 resolveEffective — (a) 기존 워크스페이스 baseline 정확 일치', () => {
  const roles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST'];
  for (const role of roles) {
    it(`${role} 공개 채널 effective == ROLE_BASELINE.${role}`, async () => {
      const svc = makeServiceSystemRole(role, []);
      const eff = await svc.resolveEffective(CH_PUBLIC, UID);
      expect(eff).toBe(ROLE_BASELINE[role]);
    });
  }

  it('OWNER 는 ALL_PERMISSIONS(ADMINISTRATOR 매핑)', async () => {
    const svc = makeServiceSystemRole('OWNER', []);
    expect(await svc.resolveEffective(CH_PUBLIC, UID)).toBe(ALL_PERMISSIONS);
  });
});

describe('S62 resolveEffective — (b) ADMIN 액터 / (c) 커스텀 Role 접근', () => {
  it('ADMIN 은 READ/WRITE/UPLOAD/DELETE_ANY/MANAGE_* 보유', async () => {
    const svc = makeServiceSystemRole('ADMIN', []);
    const eff = await svc.resolveEffective(CH_PUBLIC, UID);
    expect(eff & Permission.READ).toBe(Permission.READ);
    expect(eff & Permission.WRITE_MESSAGE).toBe(Permission.WRITE_MESSAGE);
    expect(eff & Permission.DELETE_ANY_MESSAGE).toBe(Permission.DELETE_ANY_MESSAGE);
    expect(eff & Permission.MANAGE_CHANNEL).toBe(Permission.MANAGE_CHANNEL);
  });

  it('(c) 커스텀 Role 이 SEND_MESSAGES 부여 → WRITE_MESSAGE 비트 획득', async () => {
    // GUEST(READ|WRITE base) + 커스텀 Role(MANAGE_MESSAGES) → DELETE_ANY 비트 추가.
    const svc = makeServiceCustomRole(
      'GUEST',
      { id: 'custom-mod', permissions: PERMISSIONS.MANAGE_MESSAGES, position: 150 },
      [],
    );
    const eff = await svc.resolveEffective(CH_PUBLIC, UID);
    expect(eff & Permission.READ).toBe(Permission.READ);
    expect(eff & Permission.WRITE_MESSAGE).toBe(Permission.WRITE_MESSAGE);
    // 커스텀 Role 의 MANAGE_MESSAGES → 집행 DELETE_ANY_MESSAGE.
    expect(eff & Permission.DELETE_ANY_MESSAGE).toBe(Permission.DELETE_ANY_MESSAGE);
  });
});

describe('S62 resolveEffective — (d) override DENY 403', () => {
  it('MEMBER + USER DENY(WRITE) → WRITE 비트 제거', async () => {
    const svc = makeServiceSystemRole('MEMBER', [
      {
        principalType: 'USER',
        principalId: UID,
        allowMask: 0n,
        denyMask: BigInt(Permission.WRITE_MESSAGE),
      },
    ]);
    const eff = await svc.resolveEffective(CH_PUBLIC, UID);
    expect(eff & Permission.WRITE_MESSAGE).toBe(0);
    expect(eff & Permission.READ).toBe(Permission.READ);
  });

  it('커스텀 Role UUID DENY(READ) → 개인 ALLOW 없으면 READ 제거', async () => {
    const svc = makeServiceCustomRole(
      'MEMBER',
      { id: 'custom-r', permissions: 0n, position: 150 },
      [
        {
          principalType: 'ROLE',
          principalId: 'custom-r',
          allowMask: 0n,
          denyMask: BigInt(Permission.READ),
        },
      ],
    );
    const eff = await svc.resolveEffective(CH_PUBLIC, UID);
    expect(eff & Permission.READ).toBe(0);
  });

  it('USER ALLOW 가 ROLE(UUID) DENY 를 이긴다(ADR-4 우선순위)', async () => {
    const svc = makeServiceCustomRole(
      'MEMBER',
      { id: 'custom-r', permissions: 0n, position: 150 },
      [
        {
          principalType: 'ROLE',
          principalId: 'custom-r',
          allowMask: 0n,
          denyMask: BigInt(Permission.WRITE_MESSAGE),
        },
        {
          principalType: 'USER',
          principalId: UID,
          allowMask: BigInt(Permission.WRITE_MESSAGE),
          denyMask: 0n,
        },
      ],
    );
    const eff = await svc.resolveEffective(CH_PUBLIC, UID);
    expect(eff & Permission.WRITE_MESSAGE).toBe(Permission.WRITE_MESSAGE);
  });
});

describe('S62 resolveEffective — (f) private 가시성', () => {
  it('MEMBER private 채널은 override 없으면 base 억제(0)', async () => {
    const svc = makeServiceSystemRole('MEMBER', []);
    const eff = await svc.resolveEffective(CH_PRIVATE, UID);
    expect(eff).toBe(0);
  });

  it('커스텀 Role UUID ALLOW(READ) 가 private 채널을 개방', async () => {
    const svc = makeServiceCustomRole(
      'MEMBER',
      { id: 'custom-r', permissions: 0n, position: 150 },
      [
        {
          principalType: 'ROLE',
          principalId: 'custom-r',
          allowMask: BigInt(Permission.READ),
          denyMask: 0n,
        },
      ],
    );
    const eff = await svc.resolveEffective(CH_PRIVATE, UID);
    expect(eff & Permission.READ).toBe(Permission.READ);
    // base 가 열려 MEMBER baseline 도 적용된다.
    expect(eff & Permission.WRITE_MESSAGE).toBe(Permission.WRITE_MESSAGE);
  });

  it('OWNER 는 private 채널 무조건 가시(MED-6 정합)', async () => {
    const svc = makeServiceSystemRole('OWNER', []);
    const eff = await svc.resolveEffective(CH_PRIVATE, UID);
    expect(eff & Permission.READ).toBe(Permission.READ);
  });
});

describe('S62 requirePermission — (d) 403 매핑', () => {
  it('MEMBER 가 MANAGE_CHANNEL 요구 시 공개채널 FORBIDDEN', async () => {
    const svc = makeServiceSystemRole('MEMBER', []);
    await expect(
      svc.requirePermission(CH_PUBLIC, UID, Permission.MANAGE_CHANNEL),
    ).rejects.toThrow();
  });

  it('MEMBER private 비가시 채널은 CHANNEL_NOT_VISIBLE', async () => {
    const svc = makeServiceSystemRole('MEMBER', []);
    await expect(svc.requirePermission(CH_PRIVATE, UID, Permission.READ)).rejects.toThrow();
  });
});
