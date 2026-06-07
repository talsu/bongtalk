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
import { AuditService, AuditAction } from '../../common/audit/audit.service';

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
    // S64 (FR-RM12): 역할 CRUD 를 감사 로그에 기록한다. @Global AuditModule 제공.
    private readonly audit: AuditService,
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
   *
   * S61 fix-forward (security MED-1 · TOCTOU): 권한검사→DB 쓰기를 단일 트랜잭션 +
   * 액터 MemberRole SELECT FOR UPDATE 로 감싸 update 경로와 일관되게 한다. 검사
   * 시점과 쓰기 시점 사이에 액터의 역할이 강등되는 race 를 닫는다.
   */
  async create(
    workspaceId: string,
    actorUserId: string,
    body: CreateRoleRequest,
  ): Promise<RoleDto> {
    const requested = body.permissions ? deserializePermissions(body.permissions) : 0n;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // 액터 MemberRole 행을 잠가 검사~쓰기 사이의 강등 race 를 직렬화(MED-1).
        await tx.$queryRaw`SELECT "roleId" FROM "MemberRole" WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${actorUserId}::uuid FOR UPDATE`;
        // SERIOUS-4: 액터 최대 권한 + 최고 position 을 단일 조회로 합산한다.
        const actor = await this.computeActorContext(tx, workspaceId, actorUserId);
        await this.assertGrantWithinActor(
          tx,
          workspaceId,
          actorUserId,
          requested,
          actor.maxPermissions,
          'ROLE_CREATE',
        );

        // position 미지정 시 최상위 커스텀 역할 + 1(ADMIN 400 미만으로 캡).
        const position = body.position ?? (await this.nextCustomPosition(tx, workspaceId));
        // 액터가 만들 수 있는 역할 position 은 액터 최고 position 미만이어야 한다(FR-RM04).
        if (position >= actor.topPosition) {
          await this.recordEscalationDenied(tx, workspaceId, actorUserId, {
            attempt: 'ROLE_CREATE',
            reason: 'POSITION_TOO_HIGH',
            position,
          });
          throw new DomainError(
            ErrorCode.ROLE_POSITION_TOO_HIGH,
            'cannot create a role at or above your own highest role position',
          );
        }
        const row = await tx.role.create({
          data: {
            workspaceId,
            name: body.name,
            colorHex: body.colorHex ?? null,
            position,
            permissions: toStoragePermissions(requested),
            isSystem: false,
            // S88a (FR-MN-03 · D6): 멘션 허용 플래그. 미지정 시 false(멘션 불가).
            mentionable: body.mentionable ?? false,
          },
        });
        // FR-RM12: 역할 생성 감사(같은 tx — 원자성).
        await this.audit.record(
          {
            workspaceId,
            actorId: actorUserId,
            action: AuditAction.ROLE_CREATE,
            targetId: row.id,
            details: {
              name: row.name,
              position: row.position,
              permissions: row.permissions.toString(),
              mentionable: row.mentionable,
            },
          },
          tx,
        );
        return row;
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
    // SERIOUS-4: 액터 최고 position + 최대 권한을 단일 조회로 합산(중복 findMany 제거).
    const actor = await this.computeActorContext(this.prisma, workspaceId, actorUserId);
    const actorTop = actor.topPosition;

    // FR-RM04: 자신 이상 position 역할은 수정 불가(OWNER 면제는 actorTop 가 최상위라 통과).
    if (role.position >= actorTop) {
      await this.recordEscalationDenied(this.prisma, workspaceId, actorUserId, {
        attempt: 'ROLE_UPDATE',
        reason: 'TARGET_POSITION_TOO_HIGH',
        roleId,
      });
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
    // S88a (FR-MN-03 · D6): 멘션 허용 토글. 비권한 메타라 시스템 역할도 변경 가능하다
    // (name/position/permissions 의 isSystem 불변 가드와 별개). 권한상승 검사 불요.
    if (body.mentionable !== undefined) data.mentionable = body.mentionable;
    if (body.permissions !== undefined) {
      const requested = deserializePermissions(body.permissions);
      await this.assertGrantWithinActor(
        this.prisma,
        workspaceId,
        actorUserId,
        requested,
        actor.maxPermissions,
        'ROLE_UPDATE',
      );
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
        await this.recordEscalationDenied(this.prisma, workspaceId, actorUserId, {
          attempt: 'ROLE_UPDATE',
          reason: 'NEW_POSITION_TOO_HIGH',
          roleId,
          position: target,
        });
        throw new DomainError(
          ErrorCode.ROLE_POSITION_TOO_HIGH,
          'cannot raise a role to or above your own highest role position',
        );
      }
      const updated = await this.prisma.$transaction(async (tx) => {
        // 대상 역할 row 를 잠근다(동시 position 변경 직렬화).
        await tx.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${roleId}::uuid FOR UPDATE`;
        const row = await tx.role.update({
          where: { id: roleId },
          data: { ...data, position: target },
        });
        await this.audit.record(
          {
            workspaceId,
            actorId: actorUserId,
            action: AuditAction.ROLE_UPDATE,
            targetId: roleId,
            details: { position: target },
          },
          tx,
        );
        return row;
      });
      return toRoleDto(updated);
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.role.update({ where: { id: roleId }, data });
        await this.audit.record(
          {
            workspaceId,
            actorId: actorUserId,
            action: AuditAction.ROLE_UPDATE,
            targetId: roleId,
            details: {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
              ...(body.colorHex !== undefined ? { colorHex: body.colorHex } : {}),
            },
          },
          tx,
        );
        return row;
      });
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
    const { topPosition: actorTop } = await this.computeActorContext(
      this.prisma,
      workspaceId,
      actorUserId,
    );
    if (role.position >= actorTop) {
      await this.recordEscalationDenied(this.prisma, workspaceId, actorUserId, {
        attempt: 'ROLE_DELETE',
        reason: 'TARGET_POSITION_TOO_HIGH',
        roleId,
      });
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
      // FR-RM12: 역할 삭제 감사(같은 tx — 원자성).
      await this.audit.record(
        {
          workspaceId,
          actorId: actorUserId,
          action: AuditAction.ROLE_DELETE,
          targetId: roleId,
          details: { name: role.name, position: role.position },
        },
        tx,
      );
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
   * S61 fix-forward (perf SERIOUS-4): 액터의 최대 권한(OR)과 최고 position 을 단일
   * MemberRole 조회로 함께 계산한다. 종전에는 computeActorMaxPermissions 와
   * computeActorTopPosition 이 동일 where 절로 두 번 findMany 했다.
   *
   * - maxPermissions: 보유 역할 permissions 의 OR(부호 없는 논리값). 권한 상승 방어의
   *   "부여 가능 최대 권한" 기준. ADMINISTRATOR 보유 시 모든 비트 부여 가능.
   * - topPosition: 보유 역할 중 최고 position(없으면 0).
   *
   * client 인자로 PrismaService 또는 트랜잭션 클라이언트를 받아, create 의 FOR UPDATE
   * 트랜잭션 안에서도 같은 잠금 컨텍스트로 읽도록 한다(MED-1).
   */
  private async computeActorContext(
    client: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ maxPermissions: bigint; topPosition: number }> {
    const roles = await client.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { permissions: true, position: true } } },
    });
    let maxPermissions = 0n;
    let topPosition = 0;
    for (const r of roles) {
      maxPermissions |= fromStoragePermissions(r.role.permissions);
      if (r.role.position > topPosition) topPosition = r.role.position;
    }
    return { maxPermissions, topPosition };
  }

  /** 커스텀 역할 기본 position(현재 최댓값 + 1, 단 ADMIN(400) 미만으로 캡). */
  private async nextCustomPosition(
    client: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
  ): Promise<number> {
    const top = await client.role.findFirst({
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
   *
   * S64 (FR-RM12): 권한 상승 시도가 거부되면 PRIVILEGE_ESCALATION_DENIED 감사 1행을
   * 같은 tx 에 기록한 뒤 throw 한다(보안 관찰성 — 누가 무엇을 부여하려 했는지).
   */
  private async assertGrantWithinActor(
    client: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
    actorUserId: string,
    requested: bigint,
    actorMax: bigint,
    attempt: 'ROLE_CREATE' | 'ROLE_UPDATE',
  ): Promise<void> {
    // 액터가 ADMINISTRATOR 보유자면 모든 비트 부여 가능.
    if (hasRaw(actorMax, PERMISSIONS.ADMINISTRATOR)) return;

    // ADMINISTRATOR 부여 시도인데 액터가 ADMINISTRATOR 미보유 → 권한 상승 차단.
    if (hasRaw(requested, PERMISSIONS.ADMINISTRATOR)) {
      await this.recordEscalationDenied(client, workspaceId, actorUserId, {
        attempt,
        reason: 'ADMINISTRATOR_GRANT',
        requested: requested.toString(),
      });
      throw new DomainError(
        ErrorCode.ROLE_PRIVILEGE_ESCALATION,
        'cannot grant ADMINISTRATOR without holding it',
      );
    }
    // 요청 비트가 액터 최대 권한의 부분집합이 아니면(액터에 없는 비트 부여) 차단.
    if ((requested & ~actorMax) !== 0n) {
      await this.recordEscalationDenied(client, workspaceId, actorUserId, {
        attempt,
        reason: 'PERMISSIONS_EXCEED_ACTOR',
        requested: requested.toString(),
      });
      throw new DomainError(
        ErrorCode.ROLE_PRIVILEGE_ESCALATION,
        'cannot grant permissions you do not hold',
      );
    }
  }

  /**
   * S64 (FR-RM12 / FR-RM04): 권한 상승 거부를 감사 로그에 기록한다(best-effort 가 아니라
   * 도메인 트랜잭션과 같은 client 로 — 거부 직전 기록 후 throw). targetId 는 없다(역할
   * 생성/수정 시도 단계라 대상 행이 없을 수 있음). details 에 시도 컨텍스트를 싣는다.
   */
  private async recordEscalationDenied(
    client: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
    actorUserId: string,
    details: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.audit.record(
      {
        workspaceId,
        actorId: actorUserId,
        action: AuditAction.PRIVILEGE_ESCALATION_DENIED,
        details,
      },
      client,
    );
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
    // S88a (FR-MN-03 · D6): 멘션 허용 플래그를 응답에 노출.
    mentionable: row.mentionable,
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
