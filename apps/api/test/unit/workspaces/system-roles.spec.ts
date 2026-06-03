import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  SYSTEM_ROLE_POSITION,
  PERMISSIONS,
  has,
  toStoragePermissions,
  fromStoragePermissions,
  RoleNameSchema,
  ColorHexSchema,
  PermissionsBitfieldSchema,
  CreateRoleRequestSchema,
  UpdateRoleRequestSchema,
} from '@qufox/shared-types';
import type { Prisma } from '@prisma/client';
import { syncMemberSystemRole } from '../../../src/workspaces/roles/system-role-seed';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

// S61 (FR-RM01/02): 시스템 역할 정의가 마이그레이션 backfill 값과 정합하는지 검증.
describe('S61 system role definitions', () => {
  it('defines exactly the 5 system roles', () => {
    expect([...SYSTEM_ROLE_NAMES]).toEqual(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST']);
  });

  it('positions strictly descend OWNER>ADMIN>MODERATOR>MEMBER>GUEST', () => {
    expect(SYSTEM_ROLE_POSITION.OWNER).toBeGreaterThan(SYSTEM_ROLE_POSITION.ADMIN);
    expect(SYSTEM_ROLE_POSITION.ADMIN).toBeGreaterThan(SYSTEM_ROLE_POSITION.MODERATOR);
    expect(SYSTEM_ROLE_POSITION.MODERATOR).toBeGreaterThan(SYSTEM_ROLE_POSITION.MEMBER);
    expect(SYSTEM_ROLE_POSITION.MEMBER).toBeGreaterThan(SYSTEM_ROLE_POSITION.GUEST);
  });

  it('OWNER permissions = ADMINISTRATOR bit', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.OWNER).toBe(PERMISSIONS.ADMINISTRATOR);
    // ADMINISTRATOR holder passes every flag check.
    expect(has(SYSTEM_ROLE_PERMISSIONS.OWNER, PERMISSIONS.MANAGE_CHANNEL)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.OWNER, PERMISSIONS.SEND_MESSAGES)).toBe(true);
  });

  // 마이그레이션 backfill 의 하드코딩 값과 1:1 정합(보고서 표 참조).
  it('matches the migration-seeded bitfield values', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).toBe(8191n); // 0x1FFF
    expect(SYSTEM_ROLE_PERMISSIONS.MODERATOR).toBe(7423n); // 0x1CFF
    expect(SYSTEM_ROLE_PERMISSIONS.MEMBER).toBe(3191n); // 0x0C77
    expect(SYSTEM_ROLE_PERMISSIONS.GUEST).toBe(39n); // 0x0027
  });

  it('ADMIN has MANAGE_CHANNEL/MANAGE_WEBHOOKS; MODERATOR does not', () => {
    expect(has(SYSTEM_ROLE_PERMISSIONS.ADMIN, PERMISSIONS.MANAGE_CHANNEL)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.ADMIN, PERMISSIONS.MANAGE_WEBHOOKS)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.MANAGE_CHANNEL)).toBe(false);
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.MANAGE_WEBHOOKS)).toBe(false);
    // MODERATOR keeps message-management + slowmode bypass.
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.MANAGE_MESSAGES)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.MODERATOR, PERMISSIONS.BYPASS_SLOWMODE)).toBe(true);
  });

  it('GUEST is read/post/react only — no attach', () => {
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.ADD_REACTIONS)).toBe(true);
    expect(has(SYSTEM_ROLE_PERMISSIONS.GUEST, PERMISSIONS.ATTACH_FILES)).toBe(false);
  });
});

// S61 (FR-RM02): PostgreSQL signed bigint 저장 ↔ 부호 없는 논리값 왕복.
describe('S61 storage permission round-trip', () => {
  it('ADMINISTRATOR (1<<63) stores as signed -(2^63) and recovers losslessly', () => {
    const stored = toStoragePermissions(PERMISSIONS.ADMINISTRATOR);
    expect(stored).toBe(-9223372036854775808n);
    expect(fromStoragePermissions(stored)).toBe(PERMISSIONS.ADMINISTRATOR);
  });

  it('non-ADMINISTRATOR masks are identity through storage', () => {
    for (const v of [0n, 8191n, 7423n, 3191n, 39n]) {
      expect(toStoragePermissions(v)).toBe(v);
      expect(fromStoragePermissions(v)).toBe(v);
    }
  });

  it('round-trip is total over every system role', () => {
    for (const name of SYSTEM_ROLE_NAMES) {
      const perm = SYSTEM_ROLE_PERMISSIONS[name];
      expect(fromStoragePermissions(toStoragePermissions(perm))).toBe(perm);
    }
  });
});

// S61 (ADR-11): DTO 스키마 검증.
describe('S61 role DTO schemas', () => {
  it('RoleNameSchema trims and bounds length', () => {
    expect(RoleNameSchema.parse('  Mods  ')).toBe('Mods');
    expect(() => RoleNameSchema.parse('')).toThrow();
    expect(() => RoleNameSchema.parse('   ')).toThrow();
    expect(() => RoleNameSchema.parse('x'.repeat(65))).toThrow();
  });

  it('ColorHexSchema accepts #RRGGBB only', () => {
    expect(ColorHexSchema.parse('#a1b2c3')).toBe('#a1b2c3');
    expect(() => ColorHexSchema.parse('a1b2c3')).toThrow();
    expect(() => ColorHexSchema.parse('#fff')).toThrow();
  });

  it('PermissionsBitfieldSchema accepts non-negative integer strings only', () => {
    expect(PermissionsBitfieldSchema.parse('0')).toBe('0');
    expect(PermissionsBitfieldSchema.parse('9223372036854775808')).toBe('9223372036854775808');
    expect(() => PermissionsBitfieldSchema.parse('-1')).toThrow();
    expect(() => PermissionsBitfieldSchema.parse('01')).toThrow();
    expect(() => PermissionsBitfieldSchema.parse('1.5')).toThrow();
  });

  // S61 fix-forward (reviewer BLOCKER-3): 범위 밖 비트는 Zod 에서 거부(→ 컨트롤러 422).
  it('PermissionsBitfieldSchema rejects bits outside the catalog (bit13=8192)', () => {
    // ALL_PERMISSIONS = 0x1FFF | ADMINISTRATOR(1<<63). bit13(8192=0x2000)은 미정의 →
    // 종전엔 deserialize RangeError → 500. 이제 Zod refine 이 미리 거부한다.
    expect(CreateRoleRequestSchema.safeParse({ name: 'evil', permissions: '8192' }).success).toBe(
      false,
    );
    expect(UpdateRoleRequestSchema.safeParse({ permissions: '8192' }).success).toBe(false);
    // ADMINISTRATOR 비트(1<<63)는 정의된 비트라 형식상 통과한다(권한 상승 방어는 서비스).
    expect(
      CreateRoleRequestSchema.safeParse({ name: 'ok', permissions: '9223372036854775808' }).success,
    ).toBe(true);
    // 13비트 카탈로그 합(0x1FFF=8191)도 통과.
    expect(CreateRoleRequestSchema.safeParse({ name: 'ok', permissions: '8191' }).success).toBe(
      true,
    );
  });

  // S61 fix-forward (security HIGH-2): position 은 [0, 499] 정수만.
  it('Create/Update RoleRequestSchema bounds position to [0, 499]', () => {
    expect(CreateRoleRequestSchema.safeParse({ name: 'r', position: 0 }).success).toBe(true);
    expect(CreateRoleRequestSchema.safeParse({ name: 'r', position: 499 }).success).toBe(true);
    expect(CreateRoleRequestSchema.safeParse({ name: 'r', position: -1 }).success).toBe(false);
    expect(CreateRoleRequestSchema.safeParse({ name: 'r', position: 500 }).success).toBe(false);
    expect(CreateRoleRequestSchema.safeParse({ name: 'r', position: 1e9 }).success).toBe(false);
    expect(UpdateRoleRequestSchema.safeParse({ position: 500 }).success).toBe(false);
    expect(UpdateRoleRequestSchema.safeParse({ position: 300 }).success).toBe(true);
  });
});

// S61 fix-forward (security A-1/A-2): syncMemberSystemRole 가 시스템 MemberRole 을
// 단일 불변식으로 동기화하는지(기존 시스템 행 전부 삭제 → 목표 1행 생성) 검증한다.
describe('S61 syncMemberSystemRole — system MemberRole single-invariant sync', () => {
  const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function makeTx(systemRoles: Array<{ id: string; name: string }>) {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      role: { findMany: vi.fn().mockResolvedValue(systemRoles) },
      memberRole: { deleteMany, createMany },
    } as unknown as Prisma.TransactionClient;
    return { tx, deleteMany, createMany };
  }

  it('deletes all existing system MemberRoles then creates the target one (OWNER→ADMIN demotion)', async () => {
    const systemRoles = [
      { id: 'role-owner', name: 'OWNER' },
      { id: 'role-admin', name: 'ADMIN' },
      { id: 'role-mod', name: 'MODERATOR' },
      { id: 'role-member', name: 'MEMBER' },
      { id: 'role-guest', name: 'GUEST' },
    ];
    const { tx, deleteMany, createMany } = makeTx(systemRoles);

    await syncMemberSystemRole(tx, WS, USER, 'ADMIN');

    // 1. 이 멤버의 모든 시스템 역할 MemberRole 을 먼저 삭제(OWNER 잔재 포함).
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const delArg = deleteMany.mock.calls[0][0];
    expect(delArg.where.workspaceId).toBe(WS);
    expect(delArg.where.userId).toBe(USER);
    expect(delArg.where.roleId.in).toEqual([
      'role-owner',
      'role-admin',
      'role-mod',
      'role-member',
      'role-guest',
    ]);
    // 2. 목표(ADMIN) 시스템 역할 MemberRole 1행만 생성.
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toEqual([
      { workspaceId: WS, userId: USER, roleId: 'role-admin', assignedBy: null },
    ]);
  });
});
