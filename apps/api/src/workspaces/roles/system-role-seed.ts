import type { Prisma } from '@prisma/client';
import {
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  SYSTEM_ROLE_POSITION,
  toStoragePermissions,
  type SystemRoleName,
} from '@qufox/shared-types';

/**
 * S61 (D12 / FR-RM01): 워크스페이스 생성 시 시스템 5역할을 시드한다(마이그레이션
 * backfill 과 동일 값). permissions 는 DB signed bigint 로 저장(toStoragePermissions).
 *
 * 트랜잭션 클라이언트(tx)를 받아 workspace.create 와 동일 트랜잭션에서 실행한다.
 * createMany + skipDuplicates 로 멱등하다(@@unique([workspaceId, name])).
 * 반환: name → roleId 매핑(MemberRole 시드에 사용).
 */
export async function seedSystemRoles(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<Record<SystemRoleName, string>> {
  await tx.role.createMany({
    data: SYSTEM_ROLE_NAMES.map((name) => ({
      workspaceId,
      name,
      colorHex: null,
      position: SYSTEM_ROLE_POSITION[name],
      permissions: toStoragePermissions(SYSTEM_ROLE_PERMISSIONS[name]),
      isSystem: true,
    })),
    skipDuplicates: true,
  });
  const rows = await tx.role.findMany({
    where: { workspaceId, isSystem: true },
    select: { id: true, name: true },
  });
  const map = {} as Record<SystemRoleName, string>;
  for (const r of rows) {
    if ((SYSTEM_ROLE_NAMES as readonly string[]).includes(r.name)) {
      map[r.name as SystemRoleName] = r.id;
    }
  }
  return map;
}

/**
 * S61 (FR-RM01): 멤버의 시스템 역할 enum 에 대응하는 MemberRole 을 시드한다.
 * createMany + skipDuplicates 로 멱등. assignedBy 는 시스템 시드라 null.
 */
export async function seedMemberSystemRole(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  roleName: SystemRoleName,
): Promise<void> {
  const role = await tx.role.findFirst({
    where: { workspaceId, name: roleName, isSystem: true },
    select: { id: true },
  });
  if (!role) return;
  await tx.memberRole.createMany({
    data: [{ workspaceId, userId, roleId: role.id, assignedBy: null }],
    skipDuplicates: true,
  });
}

/**
 * S61 fix-forward (security A-1/A-2 · privilege escalation 방어): 멤버의 시스템 역할
 * MemberRole 을 단일 불변식(enum ↔ 시스템 Role 1:1)으로 동기화한다.
 *
 * `WorkspaceMember.role` enum 이 바뀌는 모든 경로(가입/초대 수락/역할 변경/소유권
 * 이전)에서 호출해, 그 멤버가 보유한 **시스템** 역할 MemberRole 을 정확히 하나
 * (`roleName` 에 대응하는 행)만 갖도록 만든다:
 *   1. 그 멤버의 기존 시스템 역할 MemberRole 을 모두 삭제(다른 등급의 잔재 제거).
 *   2. `roleName` 에 대응하는 시스템 Role 의 MemberRole 을 생성(멱등).
 *
 * 커스텀(비시스템) 역할 MemberRole 은 건드리지 않는다 — 시스템 등급과 직교한다.
 *
 * A-1 의 핵심: transferOwnership 에서 ex-OWNER 의 OWNER MemberRole(ADMINISTRATOR
 * 비트) 잔재가 남으면 computeActorMaxPermissions=ADMINISTRATOR 가 되어 ex-OWNER 가
 * 자신에게 god role 을 다시 붙여 OWNER 권한을 재획득할 수 있다. 이 헬퍼가 강등 시
 * OWNER 시스템 MemberRole 을 제거하고 ADMIN 시스템 MemberRole 로 교체해 그 경로를
 * 차단한다.
 */
export async function syncMemberSystemRole(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  roleName: SystemRoleName,
): Promise<void> {
  // 해당 워크스페이스의 모든 시스템 역할 id(삭제 대상 판별 + 목표 역할 조회).
  const systemRoles = await tx.role.findMany({
    where: { workspaceId, isSystem: true },
    select: { id: true, name: true },
  });
  const target = systemRoles.find((r) => r.name === roleName);
  // 시스템 역할이 아직 시드되지 않았다면(레거시 워크스페이스 등) 시드 후 재조회한다.
  let systemRoleList = systemRoles;
  let targetRole = target;
  if (!targetRole) {
    await seedSystemRoles(tx, workspaceId);
    systemRoleList = await tx.role.findMany({
      where: { workspaceId, isSystem: true },
      select: { id: true, name: true },
    });
    targetRole = systemRoleList.find((r) => r.name === roleName);
    if (!targetRole) return; // 방어 — 시드 직후라면 항상 존재.
  }

  const systemRoleIds = systemRoleList.map((r) => r.id);
  // 1. 이 멤버의 기존 시스템 역할 MemberRole 전부 삭제(다른 등급 잔재 제거).
  await tx.memberRole.deleteMany({
    where: { workspaceId, userId, roleId: { in: systemRoleIds } },
  });
  // 2. 목표 시스템 역할 MemberRole 생성(멱등).
  await tx.memberRole.createMany({
    data: [{ workspaceId, userId, roleId: targetRole.id, assignedBy: null }],
    skipDuplicates: true,
  });
}
