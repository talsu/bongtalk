import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkspaceRole } from '@prisma/client';
import { ROLE_RANK, WorkspaceRole as SharedRole } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import {
  MEMBER_LEFT,
  MEMBER_REMOVED,
  ROLE_CHANGED,
} from '../events/workspace-events';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
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
    // An ADMIN cannot promote/demote an equal-or-higher rank (role rank parity).
    if (
      ROLE_RANK[actorRole] <= ROLE_RANK[target.role as SharedRole] &&
      actorRole !== 'OWNER'
    ) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'cannot modify a member of equal or higher rank',
      );
    }
    const updated = await this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      data: { role: nextRole === 'ADMIN' ? WorkspaceRole.ADMIN : WorkspaceRole.MEMBER },
    });
    this.emitter.emit(ROLE_CHANGED, {
      workspaceId,
      userId: targetUserId,
      actorId,
      from: target.role,
      to: updated.role,
    });
    return updated;
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
    await this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    this.emitter.emit(MEMBER_REMOVED, { workspaceId, userId: targetUserId, actorId });
  }

  async leave(workspaceId: string, userId: string, role: SharedRole) {
    if (role === 'OWNER') {
      throw new DomainError(
        ErrorCode.WORKSPACE_OWNER_MUST_TRANSFER,
        'owner must transfer ownership before leaving',
      );
    }
    await this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    this.emitter.emit(MEMBER_LEFT, { workspaceId, userId, actorId: userId });
  }
}
