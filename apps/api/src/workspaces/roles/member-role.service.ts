import { Injectable } from '@nestjs/common';
import { fromStoragePermissions, PERMISSIONS, hasRaw } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S61 (D12 / FR-RM01·04): 멤버 ↔ 역할 부여/회수 + privilege escalation 방어.
 *
 * - 부여 가능한 최대 권한은 액터 자신의 현재 최고 position 이하 역할로 제한
 *   (FR-RM04): 액터는 자신의 최고 position 이상인 역할을 멤버에게 부여할 수 없다.
 * - ADMINISTRATOR 비트를 가진 역할은 액터가 ADMINISTRATOR 보유자일 때만 부여 가능
 *   (MANAGE_ROLES 만으로 ADMINISTRATOR 역할을 타인에게 붙여 권한 상승하는 것 차단).
 */
@Injectable()
export class MemberRoleService {
  constructor(private readonly prisma: PrismaService) {}

  /** 멤버가 보유한 역할 목록(roleId). */
  async listForMember(workspaceId: string, userId: string): Promise<string[]> {
    const rows = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId },
      select: { roleId: true },
    });
    return rows.map((r) => r.roleId);
  }

  /**
   * S61 (FR-RM04): 액터가 대상 멤버에게 역할을 부여한다. 권한 상승 방어를 거친다.
   */
  async assign(
    workspaceId: string,
    actorUserId: string,
    targetUserId: string,
    roleId: string,
  ): Promise<void> {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, workspaceId } });
    if (!role) {
      throw new DomainError(ErrorCode.ROLE_NOT_FOUND, 'role not found in workspace');
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_TARGET_NOT_MEMBER, 'target is not a member');
    }

    const { topPosition, maxPermissions, isAdministrator } = await this.actorContext(
      workspaceId,
      actorUserId,
    );

    // FR-RM04: 자신 이상 position 역할은 부여 불가(OWNER 면제 — OWNER 는 actorTop 최상위).
    if (!isAdministrator && role.position >= topPosition) {
      throw new DomainError(
        ErrorCode.ROLE_POSITION_TOO_HIGH,
        'cannot assign a role at or above your own highest role position',
      );
    }

    // FR-RM04: 부여하려는 역할이 액터가 보유하지 않은 권한 비트를 담으면 차단.
    const rolePerms = fromStoragePermissions(role.permissions);
    if (!isAdministrator) {
      if (hasRaw(rolePerms, PERMISSIONS.ADMINISTRATOR)) {
        throw new DomainError(
          ErrorCode.ROLE_PRIVILEGE_ESCALATION,
          'cannot assign an ADMINISTRATOR role without holding ADMINISTRATOR',
        );
      }
      if ((rolePerms & ~maxPermissions) !== 0n) {
        throw new DomainError(
          ErrorCode.ROLE_PRIVILEGE_ESCALATION,
          'cannot assign a role granting permissions you do not hold',
        );
      }
    }

    await this.prisma.memberRole.upsert({
      where: { workspaceId_userId_roleId: { workspaceId, userId: targetUserId, roleId } },
      create: { workspaceId, userId: targetUserId, roleId, assignedBy: actorUserId },
      update: {},
    });
  }

  /**
   * S61 (FR-RM04): 역할 회수. 시스템 역할 회수는 허용하되, 자신 이상 position
   * 역할을 가진 대상은 건드릴 수 없다(상위 멤버 보호).
   */
  async revoke(
    workspaceId: string,
    actorUserId: string,
    targetUserId: string,
    roleId: string,
  ): Promise<void> {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, workspaceId } });
    if (!role) {
      throw new DomainError(ErrorCode.ROLE_NOT_FOUND, 'role not found in workspace');
    }
    const { topPosition, isAdministrator } = await this.actorContext(workspaceId, actorUserId);
    if (!isAdministrator && role.position >= topPosition) {
      throw new DomainError(
        ErrorCode.ROLE_POSITION_TOO_HIGH,
        'cannot revoke a role at or above your own highest role position',
      );
    }
    await this.prisma.memberRole.deleteMany({
      where: { workspaceId, userId: targetUserId, roleId },
    });
  }

  /** 액터의 권한 상승 방어 컨텍스트(최고 position · 최대 권한 OR · ADMINISTRATOR 여부). */
  private async actorContext(
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ topPosition: number; maxPermissions: bigint; isAdministrator: boolean }> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { position: true, permissions: true } } },
    });
    let topPosition = 0;
    let maxPermissions = 0n;
    for (const r of roles) {
      if (r.role.position > topPosition) topPosition = r.role.position;
      maxPermissions |= fromStoragePermissions(r.role.permissions);
    }
    return {
      topPosition,
      maxPermissions,
      isAdministrator: hasRaw(maxPermissions, PERMISSIONS.ADMINISTRATOR),
    };
  }
}
