import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  fromStoragePermissions,
  hasRaw,
  KICK_UNDO_TTL_SECONDS,
  PERMISSIONS,
  SYSTEM_ROLE_POSITION,
  type KickMemberResponse,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { MemberRoleService } from '../roles/member-role.service';
import { syncMemberSystemRole } from '../roles/system-role-seed';
import { MEMBER_KICKED } from '../events/workspace-events';

/**
 * S63 (D12 / FR-RM05·06·07): 모더레이션(Kick / Ban / Timeout) 도메인 서비스.
 *
 * Fork D: members.service.remove(소유권/역할 enum 회귀 방지)와 분리한 신규 서비스다.
 * 권한 게이트는 카탈로그 모더레이션 비트(KICK_MEMBERS/BAN_MEMBERS/TIMEOUT_MEMBERS)를
 * actor 의 보유 Role permissions OR 로 직접 검사한다(S62 채널 집행 enum 과 별개의
 * 워크스페이스 레벨 권한). position 계층 방어(S61)와 자기 자신 대상 방지를 공유한다.
 *
 * undoToken/세션 무효화는 prod 보안 요구다 — kick/ban 모두 outbox 이벤트가
 * kickUserEverywhere 를 트리거해 멀티노드 소켓을 즉시 끊는다(Redis adapter 도달).
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    // 강제 퇴장/차단/타임아웃 후 대상 멤버의 채널 권한 캐시 무효화(stale 권한 차단).
    private readonly memberRoles: MemberRoleService,
    // kick undo 토큰(Redis TTL 5초). 부재 시 undo 비활성(토큰 발급은 하되 검증 불가
    // 상황을 방지하기 위해 발급 자체를 best-effort 로 둔다 — 아래 kick 참조).
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /**
   * FR-RM05: 멤버 강제 퇴장. WorkspaceMember 삭제 + 즉시 WS disconnect(outbox →
   * kickUserEverywhere) + 재초대 시 재가입 가능(BannedMember 미기록). 5초 Undo 토큰을
   * actor 에게만 반환한다(HTTP 응답 — 브로드캐스트 제외). AuditLog 필수.
   */
  async kick(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    reason?: string;
  }): Promise<KickMemberResponse> {
    const { workspaceId, actorId, targetUserId } = args;
    const reason = normalizeReason(args.reason);
    const target = await this.assertTargetActionable(
      workspaceId,
      actorId,
      targetUserId,
      PERMISSIONS.KICK_MEMBERS,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      // FR-RM05: kicked 은 재가입 가능 — BannedMember 를 남기지 않는다.
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: targetUserId,
        eventType: MEMBER_KICKED,
        payload: { workspaceId, userId: targetUserId, actorId },
      });
      // FR-RM17: 감사 로그(같은 tx — 원자성). reason 은 details 에만 싣는다.
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.MEMBER_KICK,
          targetId: targetUserId,
          details: reason ? { reason, previousRole: target.role } : { previousRole: target.role },
        },
        tx,
      );
    });
    // 강등/삭제로 stale 권한 캐시가 남지 않게 무효화(best-effort).
    await this.memberRoles.invalidateMemberPermsCache(workspaceId, targetUserId);

    // FR-RM05: 5초 Undo 토큰. actor 가 자신의 HTTP 응답으로만 받는다(브로드캐스트
    // 제외). undoToken → 대상 userId 매핑을 Redis 에 TTL 5초로 저장한다.
    const undoToken = randomUUID();
    const undoExpiresAt = new Date(Date.now() + KICK_UNDO_TTL_SECONDS * 1000);
    if (this.redis) {
      try {
        await this.redis.set(
          kickUndoKey(workspaceId, actorId, targetUserId),
          undoToken,
          'EX',
          KICK_UNDO_TTL_SECONDS,
        );
      } catch {
        // best-effort — Redis 부재/실패 시 undo 윈도가 없을 뿐 kick 은 확정됐다.
      }
    }
    return { undoToken, undoExpiresAt: undoExpiresAt.toISOString() };
  }

  /**
   * FR-RM05: kick 5초 Undo. actor 가 발급받은 undoToken 으로 대상을 재가입시킨다.
   * 토큰 만료/무효/이미 사용이면 409. 대상이 이미 재가입했거나(멤버 존재) 차단됐으면
   * 409(KICK_UNDO_INVALID 의미 확장 — undo 적용 불가 상태).
   */
  async kickUndo(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    undoToken: string;
  }): Promise<void> {
    const { workspaceId, actorId, targetUserId, undoToken } = args;
    if (!this.redis) {
      // Redis 부재 시 undo 토큰을 검증할 수 없으므로 거부한다(보안 — 무토큰 재가입 금지).
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'undo window unavailable');
    }
    const key = kickUndoKey(workspaceId, actorId, targetUserId);
    const stored = await this.redis.get(key);
    if (!stored || stored !== undoToken) {
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'undo token expired or invalid');
    }
    // 토큰 1회용 — 즉시 삭제해 재사용을 막는다.
    await this.redis.del(key);

    // 대상이 그 사이 차단됐으면 undo 불가(차단 우선).
    const banned = await this.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { userId: true },
    });
    if (banned) {
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'target was banned after kick');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.create({
          data: { workspaceId, userId: targetUserId, role: WorkspaceRole.MEMBER },
        });
        // 재가입은 가입(invites.accept) 경로와 동일하게 MEMBER 시스템 MemberRole 을
        // 동기한다(enum ↔ 시스템 Role 불변식 — 누락 시 역할 관리 전부 거부됨).
        await syncMemberSystemRole(tx, workspaceId, targetUserId, 'MEMBER');
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: targetUserId,
          eventType: 'workspace.member.joined',
          payload: { workspaceId, userId: targetUserId, actorId },
        });
      });
    } catch (e) {
      // 대상이 이미 재가입(멤버 존재)했으면 P2002 — undo 적용 불가(409).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'target already rejoined');
      }
      throw e;
    }
  }

  // ── 공유 가드 ────────────────────────────────────────────────────────────────

  /**
   * S63 권한 게이트 + 계층 방어 공통 진입점:
   *   1. 자기 자신 대상 금지(MODERATION_CANNOT_SELF).
   *   2. actor 가 해당 모더레이션 비트(또는 ADMINISTRATOR)를 보유하는지 검사(403).
   *   3. 대상이 현재 멤버이면 actor 보다 상위 position 이 아닌지 검사(MODERATION_TARGET_HIGHER).
   *      OWNER 대상은 항상 거부(최상위). actor 가 ADMINISTRATOR 면 position 면제.
   *
   * 반환: 대상의 현재 WorkspaceMember(audit details 의 previousRole 용).
   */
  private async assertTargetActionable(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    requiredBit: bigint,
  ): Promise<{ role: WorkspaceRole }> {
    if (actorId === targetUserId) {
      throw new DomainError(ErrorCode.MODERATION_CANNOT_SELF, 'cannot moderate yourself');
    }
    const actor = await this.actorContext(workspaceId, actorId);
    if (!actor.isAdministrator && !hasRaw(actor.permissions, requiredBit)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you lack the required moderation permission',
      );
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { role: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_TARGET_NOT_MEMBER, 'target user is not a member');
    }
    // OWNER 는 어떤 모더레이션 대상도 될 수 없다(최상위 — transfer-ownership 전용).
    if (target.role === WorkspaceRole.OWNER) {
      throw new DomainError(ErrorCode.MODERATION_TARGET_HIGHER, 'cannot moderate the owner');
    }
    // S61 계층 방어: 대상의 최고 position 이 actor 의 최고 position 이상이면 거부한다.
    // ADMINISTRATOR 보유 actor 는 면제(최상위 권한).
    if (!actor.isAdministrator) {
      const targetTop = await this.topPosition(workspaceId, targetUserId, target.role);
      if (targetTop >= actor.topPosition) {
        throw new DomainError(
          ErrorCode.MODERATION_TARGET_HIGHER,
          'target outranks you — cannot moderate a member at or above your highest role',
        );
      }
    }
    return target;
  }

  /** actor 의 최고 position · 권한 OR · ADMINISTRATOR 여부(MemberRoleService 패턴 재사용). */
  private async actorContext(
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ topPosition: number; permissions: bigint; isAdministrator: boolean }> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { position: true, permissions: true } } },
    });
    let topPosition = 0;
    let permissions = 0n;
    for (const r of roles) {
      if (r.role.position > topPosition) topPosition = r.role.position;
      permissions |= fromStoragePermissions(r.role.permissions);
    }
    return {
      topPosition,
      permissions,
      isAdministrator: hasRaw(permissions, PERMISSIONS.ADMINISTRATOR),
    };
  }

  /**
   * 대상의 최고 역할 position. MemberRole 행이 있으면 그 최댓값을, 없으면(레거시
   * 멤버) 시스템 역할 enum 의 기본 position 으로 폴백한다(계층 비교가 항상 가능하게).
   */
  private async topPosition(
    workspaceId: string,
    userId: string,
    fallbackRole: WorkspaceRole,
  ): Promise<number> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId },
      select: { role: { select: { position: true } } },
    });
    if (roles.length === 0) {
      return SYSTEM_ROLE_POSITION[fallbackRole] ?? 0;
    }
    return roles.reduce((top, r) => (r.role.position > top ? r.role.position : top), 0);
  }
}

/** FR-RM05: kick undo Redis 키. actor·target 쌍으로 스코프해 충돌을 막는다. */
function kickUndoKey(workspaceId: string, actorId: string, targetUserId: string): string {
  return `kick_undo:${workspaceId}:${actorId}:${targetUserId}`;
}

/** 사유 정규화 — trim 후 빈 문자열이면 null(미제공 취급). Zod 가 길이는 이미 검증. */
function normalizeReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}
