import { Injectable } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { ROLE_RANK, WorkspaceRole as SharedRole } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { MEMBER_LEFT, MEMBER_REMOVED, ROLE_CHANGED } from '../events/workspace-events';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  list(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, email: true, username: true } } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async updateRole(
    workspaceId: string,
    actorId: string,
    actorRole: SharedRole,
    targetUserId: string,
    nextRole: 'ADMIN' | 'MEMBER',
  ) {
    if (actorId === targetUserId) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you cannot change your own role',
      );
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (!target) {
      throw new DomainError(
        ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
        'target user is not a member',
      );
    }
    if (target.role === WorkspaceRole.OWNER) {
      throw new DomainError(
        ErrorCode.WORKSPACE_CANNOT_DEMOTE_OWNER,
        'owner must use transfer-ownership',
      );
    }
    if (
      ROLE_RANK[actorRole] <= ROLE_RANK[target.role as SharedRole] &&
      actorRole !== 'OWNER'
    ) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'cannot modify a member of equal or higher rank',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: { role: nextRole === 'ADMIN' ? WorkspaceRole.ADMIN : WorkspaceRole.MEMBER },
      });
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: targetUserId,
        eventType: ROLE_CHANGED,
        payload: {
          workspaceId,
          userId: targetUserId,
          actorId,
          from: target.role,
          to: updated.role,
        },
      });
      return updated;
    });
  }

  async remove(
    workspaceId: string,
    actorId: string,
    actorRole: SharedRole,
    targetUserId: string,
  ) {
    if (actorId === targetUserId) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'use /members/me/leave to leave a workspace',
      );
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (!target) {
      throw new DomainError(
        ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
        'target user is not a member',
      );
    }
    if (target.role === WorkspaceRole.OWNER) {
      throw new DomainError(
        ErrorCode.WORKSPACE_CANNOT_REMOVE_OWNER,
        'owner cannot be removed — transfer ownership first',
      );
    }
    if (
      ROLE_RANK[actorRole] <= ROLE_RANK[target.role as SharedRole] &&
      actorRole !== 'OWNER'
    ) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'cannot remove a member of equal or higher rank',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: targetUserId,
        eventType: MEMBER_REMOVED,
        payload: { workspaceId, userId: targetUserId, actorId },
      });
    });
  }

  async leave(workspaceId: string, userId: string, role: SharedRole) {
    if (role === 'OWNER') {
      throw new DomainError(
        ErrorCode.WORKSPACE_OWNER_MUST_TRANSFER,
        'owner must transfer ownership before leaving',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId } },
      });
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: userId,
        eventType: MEMBER_LEFT,
        payload: { workspaceId, userId, actorId: userId },
      });
    });
  }
}
