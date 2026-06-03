import { Injectable } from '@nestjs/common';
import { Prisma, type Role as PrismaRole } from '@prisma/client';
import {
  PERMISSIONS,
  hasRaw,
  deserializePermissions,
  serializePermissions,
  toStoragePermissions,
  fromStoragePermissions,
  type CreateRoleRequest,
  type UpdateRoleRequest,
  type Role as RoleDto,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { RoleCacheQueueService } from '../../queue/role-cache-queue.service';

/**
 * S61 (D12 / FR-RM01·02·04·15): 커스텀 Role CRUD + 권한 상승 방어 + 삭제 cascade.
 *
 * - 시스템 역할(isSystem=true)은 name/position 변경·삭제 불가(FR-RM01).
 * - privilege escalation 방어(FR-RM04): 액터가 자신의 보유 권한을 초과하는
 *   권한을 새 역할/수정에 부여하거나, 자신 이상 position 역할을 건드릴 수 없다.
 *   ADMINISTRATOR 비트 부여는 액터가 ADMINISTRATOR 보유자일 때만 허용.
 * - 삭제 cascade(FR-RM15): MemberRole 은 onDelete Cascade(DB), roleId ROLE
 *   override 행은 같은 트랜잭션에서 삭제, 보유 멤버 권한 캐시는 즉시/배치 DEL.
 *
 * permissions 는 ADR-4 카탈로그 BigInt(부호 없는 논리값)로 다루며, DB 저장 시
 * toStoragePermissions(signed) · 읽을 때 fromStoragePermissions(unsigned)로 왕복한다.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleCache: RoleCacheQueueService,
  ) {}

  /** 워크스페이스의 모든 역할(position 내림차순 = 상위 우선). */
  async list(workspaceId: string): Promise<RoleDto[]> {
    const rows = await this.prisma.role.findMany({
      where: { workspaceId },
      orderBy: { position: 'desc' },
    });
    return rows.map((r) => toRoleDto(r));
  }

  /** 단일 역할 조회. 없으면 ROLE_NOT_FOUND. */
  async get(workspaceId: string, roleId: string): Promise<RoleDto> {
    const row = await this.findRoleOrThrow(workspaceId, roleId);
    return toRoleDto(row);
  }

  /**
   * S61 (FR-RM01/04): 커스텀 역할 생성. ADMIN+ 게이트는 컨트롤러가 강제하고,
   * 여기서는 권한 상승 방어를 한다 — 부여 권한은 액터 최대 권한 이하로 제한.
   */
  async create(
    workspaceId: string,
    actorUserId: string,
    body: CreateRoleRequest,
  ): Promise<RoleDto> {
    const actorMax = await this.computeActorMaxPermissions(workspaceId, actorUserId);
    const requested = body.permissions ? deserializePermissions(body.permissions) : 0n;
    this.assertGrantWithinActor(requested, actorMax);

    // position 미지정 시 최상위 커스텀 역할 + 1(시스템 OWNER 500 미만 권장이나
    // 사용자가 명시하지 않으면 기존 최댓값 위로 두지 않고 ADMIN(400) 아래 안전값).
    const position = body.position ?? (await this.nextCustomPosition(workspaceId));
    // 액터가 만들 수 있는 역할 position 은 액터 최고 position 이하여야 한다(FR-RM04).
    const actorTop = await this.computeActorTopPosition(workspaceId, actorUserId);
    if (position >= actorTop) {
      throw new DomainError(
        ErrorCode.ROLE_POSITION_TOO_HIGH,
        'cannot create a role at or above your own highest role position',
      );
    }

    try {
      const created = await this.prisma.role.create({
        data: {
          workspaceId,
          name: body.name,
          colorHex: body.colorHex ?? null,
          position,
          permissions: toStoragePermissions(requested),
          isSystem: false,
        },
      });
      return toRoleDto(created);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  /**
   * S61 (FR-RM01/04): 역할 수정. 시스템 역할은 name/position 변경 불가. permissions
   * 변경은 권한 상승 방어를 거친다. position 변경은 트랜잭션 + SELECT FOR UPDATE.
   */
  async update(
    workspaceId: string,
    actorUserId: string,
    roleId: string,
    body: UpdateRoleRequest,
  ): Promise<RoleDto> {
    const role = await this.findRoleOrThrow(workspaceId, roleId);
    const actorTop = await this.computeActorTopPosition(workspaceId, actorUserId);

    // FR-RM04: 자신 이상 position 역할은 수정 불가(OWNER 면제는 actorTop 가 최상위라 통과).
    if (role.position >= actorTop) {
      throw new DomainError(
        ErrorCode.ROLE_POSITION_TOO_HIGH,
        'cannot modify a role at or above your own highest role position',
      );
    }

    // 시스템 역할은 name/position 불가(color/permissions 도 잠그는 게 안전하나 PRD 는
    // name/position 만 명시 — color/permissions 도 시스템 역할은 막아 무결성 유지).
    if (role.isSystem && (body.name !== undefined || body.position !== undefined)) {
      throw new DomainError(
        ErrorCode.ROLE_SYSTEM_IMMUTABLE,
        'system role name/position is immutable',
      );
    }

    const data: Prisma.RoleUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.colorHex !== undefined) data.colorHex = body.colorHex;
    if (body.permissions !== undefined) {
      const requested = deserializePermissions(body.permissions);
      const actorMax = await this.computeActorMaxPermissions(workspaceId, actorUserId);
      this.assertGrantWithinActor(requested, actorMax);
      // 시스템 역할 permissions 변경 금지(OWNER=ADMINISTRATOR 고정 등 무결성).
      if (role.isSystem) {
        throw new DomainError(
          ErrorCode.ROLE_SYSTEM_IMMUTABLE,
          'system role permissions are immutable',
        );
      }
      data.permissions = toStoragePermissions(requested);
    }

    // position 변경: 트랜잭션 + SELECT FOR UPDATE 로 동시성 보호(FR-RM04).
    if (body.position !== undefined && body.position !== role.position) {
      const target = body.position;
      if (target >= actorTop) {
        throw new DomainError(
          ErrorCode.ROLE_POSITION_TOO_HIGH,
          'cannot raise a role to or above your own highest role position',
        );
      }
      const updated = await this.prisma.$transaction(async (tx) => {
        // 대상 역할 row 를 잠근다(동시 position 변경 직렬화).
        await tx.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${roleId}::uuid FOR UPDATE`;
        return tx.role.update({ where: { id: roleId }, data: { ...data, position: target } });
      });
      return toRoleDto(updated);
    }

    try {
      const updated = await this.prisma.role.update({ where: { id: roleId }, data });
      return toRoleDto(updated);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  /**
   * S61 (FR-RM15): 역할 삭제 cascade. 시스템 역할은 삭제 불가. 삭제 트랜잭션에서
   * roleId 의 ROLE override 행을 함께 삭제하고(MemberRole 은 DB onDelete Cascade),
   * 보유 멤버의 권한 캐시를 즉시/배치 DEL 한다. 삭제 후 권한은 즉시 재계산된다.
   */
  async remove(workspaceId: string, actorUserId: string, roleId: string): Promise<void> {
    const role = await this.findRoleOrThrow(workspaceId, roleId);
    if (role.isSystem) {
      throw new DomainError(ErrorCode.ROLE_SYSTEM_IMMUTABLE, 'system role cannot be deleted');
    }
    const actorTop = await this.computeActorTopPosition(workspaceId, actorUserId);
    if (role.position >= actorTop) {
      throw new DomainError(
        ErrorCode.ROLE_POSITION_TOO_HIGH,
        'cannot delete a role at or above your own highest role position',
      );
    }

    // 영향받는 멤버 + 워크스페이스 채널을 먼저 수집(캐시 키 조합용 · 삭제 전).
    const [members, channels] = await Promise.all([
      this.prisma.memberRole.findMany({ where: { roleId }, select: { userId: true } }),
      this.prisma.channel.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true },
      }),
    ]);

    // 삭제 트랜잭션: ROLE override 행 삭제 + Role 삭제(MemberRole 은 cascade).
    await this.prisma.$transaction(async (tx) => {
      await tx.channelPermissionOverride.deleteMany({
        where: {
          principalType: 'ROLE',
          principalId: roleId,
          channel: { workspaceId },
        },
      });
      await tx.role.delete({ where: { id: roleId } });
    });

    // 권한 캐시 무효화(≤1000 즉시 / >1000 BullMQ 배치). best-effort.
    await this.roleCache.invalidateForDeletedRole({
      workspaceId,
      roleId,
      userIds: members.map((m) => m.userId),
      channelIds: channels.map((c) => c.id),
    });
  }

  // ── 내부 헬퍼 ──────────────────────────────────────────────────────────────

  private async findRoleOrThrow(workspaceId: string, roleId: string): Promise<PrismaRole> {
    const row = await this.prisma.role.findFirst({ where: { id: roleId, workspaceId } });
    if (!row) {
      throw new DomainError(ErrorCode.ROLE_NOT_FOUND, 'role not found in workspace');
    }
    return row;
  }

  /**
   * 액터가 보유한 모든 역할 permissions 의 OR(부호 없는 논리값). 권한 상승 방어의
   * "부여 가능 최대 권한" 기준이다. ADMINISTRATOR 보유 시 모든 비트 부여 가능.
   */
  private async computeActorMaxPermissions(
    workspaceId: string,
    actorUserId: string,
  ): Promise<bigint> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { permissions: true } } },
    });
    let mask = 0n;
    for (const r of roles) {
      mask |= fromStoragePermissions(r.role.permissions);
    }
    return mask;
  }

  /** 액터가 보유한 역할 중 최고 position(없으면 -Infinity 방지로 0). */
  private async computeActorTopPosition(workspaceId: string, actorUserId: string): Promise<number> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { position: true } } },
    });
    let top = 0;
    for (const r of roles) {
      if (r.role.position > top) top = r.role.position;
    }
    return top;
  }

  /** 커스텀 역할 기본 position(현재 최댓값 + 1, 단 ADMIN(400) 미만으로 캡). */
  private async nextCustomPosition(workspaceId: string): Promise<number> {
    const top = await this.prisma.role.findFirst({
      where: { workspaceId, isSystem: false },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const next = (top?.position ?? 0) + 1;
    return Math.min(next, 399);
  }

  /**
   * S61 (FR-RM04): 부여하려는 권한이 액터 최대 권한을 초과하면 거부(403).
   * ADMINISTRATOR 비트는 액터가 ADMINISTRATOR 보유자일 때만 부여 가능
   * (MANAGE_ROLES 만으로 자신/타 역할에 ADMINISTRATOR 부여 시도 차단).
   */
  private assertGrantWithinActor(requested: bigint, actorMax: bigint): void {
    // 액터가 ADMINISTRATOR 보유자면 모든 비트 부여 가능.
    if (hasRaw(actorMax, PERMISSIONS.ADMINISTRATOR)) return;

    // ADMINISTRATOR 부여 시도인데 액터가 ADMINISTRATOR 미보유 → 권한 상승 차단.
    if (hasRaw(requested, PERMISSIONS.ADMINISTRATOR)) {
      throw new DomainError(
        ErrorCode.ROLE_PRIVILEGE_ESCALATION,
        'cannot grant ADMINISTRATOR without holding it',
      );
    }
    // 요청 비트가 액터 최대 권한의 부분집합이 아니면(액터에 없는 비트 부여) 차단.
    if ((requested & ~actorMax) !== 0n) {
      throw new DomainError(
        ErrorCode.ROLE_PRIVILEGE_ESCALATION,
        'cannot grant permissions you do not hold',
      );
    }
  }
}

/** PrismaRole → DTO. permissions 는 unsigned 논리값 string(ADR-11). */
function toRoleDto(row: PrismaRole): RoleDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    colorHex: row.colorHex,
    position: row.position,
    permissions: serializePermissions(fromStoragePermissions(row.permissions)),
    isSystem: row.isSystem,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** @@unique([workspaceId, name]) 위반을 ROLE_NAME_TAKEN 으로 매핑. */
function mapUniqueViolation(err: unknown): DomainError {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new DomainError(ErrorCode.ROLE_NAME_TAKEN, 'a role with this name already exists');
  }
  if (err instanceof DomainError) return err;
  return new DomainError(ErrorCode.INTERNAL, 'role operation failed');
}
