import { Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  CreateWorkspaceRequest,
  RESERVED_SLUGS,
  ROLE_RANK,
  UpdateWorkspaceRequest,
  WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import {
  OWNERSHIP_TRANSFERRED,
  WORKSPACE_CREATED,
  WORKSPACE_DELETED,
  WORKSPACE_RESTORED,
} from './events/workspace-events';

/**
 * Every state-change writes an OutboxEvent inside the same Prisma transaction
 * as the business row. The dispatcher picks it up after commit — so subscribers
 * never see pre-commit state, and a mid-request crash leaves no orphan event.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  private get graceMs(): number {
    return Number(process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS ?? 30) * 24 * 60 * 60 * 1000;
  }

  async create(userId: string, input: CreateWorkspaceRequest) {
    if (RESERVED_SLUGS.has(input.slug)) {
      throw new DomainError(ErrorCode.WORKSPACE_SLUG_RESERVED, `slug "${input.slug}" is reserved`);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            id: randomUUID(),
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            iconUrl: input.iconUrl ?? null,
            ownerId: userId,
            members: {
              create: { userId, role: WorkspaceRole.OWNER },
            },
          },
        });
        await this.outbox.record(tx, {
          aggregateType: 'workspace',
          aggregateId: workspace.id,
          eventType: WORKSPACE_CREATED,
          payload: { workspaceId: workspace.id, ownerId: userId, slug: workspace.slug },
        });
        return workspace;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.WORKSPACE_SLUG_TAKEN, `slug "${input.slug}" is taken`);
      }
      throw e;
    }
  }

  listMine(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getWithMyRole(workspaceId: string, userId: string) {
    const [workspace, member] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId } }),
      this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      }),
    ]);
    if (!workspace || !member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    return { workspace, myRole: member.role as SharedWorkspaceRole };
  }

  async update(workspaceId: string, input: UpdateWorkspaceRequest) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.iconUrl !== undefined ? { iconUrl: input.iconUrl } : {}),
      },
    });
  }

  async softDelete(workspaceId: string, actorId: string) {
    const now = new Date();
    const deleteAt = new Date(now.getTime() + this.graceMs);
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: { deletedAt: now, deleteAt },
      });
      await this.outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: workspace.id,
        eventType: WORKSPACE_DELETED,
        payload: { workspaceId: workspace.id, actorId, deleteAt: deleteAt.toISOString() },
      });
      return workspace;
    });
  }

  async restore(workspaceId: string, actorId: string) {
    const current = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { deletedAt: true, deleteAt: true },
    });
    if (!current?.deletedAt || !current.deleteAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace is not deleted');
    }
    if (current.deleteAt.getTime() <= Date.now()) {
      throw new DomainError(
        ErrorCode.WORKSPACE_PURGED,
        'grace period elapsed — workspace is permanently gone',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: { deletedAt: null, deleteAt: null },
      });
      await this.outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: workspace.id,
        eventType: WORKSPACE_RESTORED,
        payload: { workspaceId: workspace.id, actorId },
      });
      return workspace;
    });
  }

  /**
   * Atomic transfer — demote old OWNER, promote new OWNER, flip ownerId, and
   * record the event all inside a single `$transaction`. An observer reading
   * `OutboxEvent` never sees the committed update without the matching event.
   */
  async transferOwnership(workspaceId: string, fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) {
      throw new DomainError(
        ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
        'cannot transfer ownership to yourself',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: toUserId } },
      });
      if (!target) {
        throw new DomainError(
          ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
          'target user is not a member of this workspace',
        );
      }
      await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: fromUserId } },
        data: { role: WorkspaceRole.ADMIN },
      });
      await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: toUserId } },
        data: { role: WorkspaceRole.OWNER },
      });
      const workspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: { ownerId: toUserId },
      });
      await this.outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: workspaceId,
        eventType: OWNERSHIP_TRANSFERRED,
        payload: { workspaceId, fromUserId, toUserId },
      });
      return workspace;
    });
  }

  /** Used by guards/services that want to confirm caller is OWNER. */
  isOwner(role: string): boolean {
    return ROLE_RANK[role as SharedWorkspaceRole] === ROLE_RANK.OWNER;
  }
}
