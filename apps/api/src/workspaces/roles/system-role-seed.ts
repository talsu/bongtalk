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
