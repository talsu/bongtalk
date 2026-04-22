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
            // task-030: visibility defaults to PRIVATE. When PUBLIC, the
            // shared-types schema has already enforced category +
            // description at the zod layer.
            visibility: input.visibility ?? 'PRIVATE',
            category: input.category ?? null,
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
    // task-030: PUBLIC transition requires category + description to be
    // present on the merged state (either pre-existing or in this patch).
    if (input.visibility === 'PUBLIC') {
      const current = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { category: true, description: true },
      });
      const merged = {
        category: input.category !== undefined ? input.category : current?.category,
        description: input.description !== undefined ? input.description : current?.description,
      };
      if (!merged.category) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'category is required when switching to PUBLIC',
        );
      }
      if (!merged.description || merged.description.trim().length === 0) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'description is required when switching to PUBLIC',
        );
      }
    }
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.iconUrl !== undefined ? { iconUrl: input.iconUrl } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      },
    });
  }

  async discover(opts: { category?: string; q?: string; cursor: string | null; limit: number }) {
    const capped = Math.max(1, Math.min(50, opts.limit));
    const q = (opts.q ?? '').trim();
    const cat = (opts.category ?? '').trim();
    let cursorParts: { memberCount: number; id: string } | null = null;
    if (opts.cursor) {
      const [mc, id] = opts.cursor.split('|');
      if (mc && id) cursorParts = { memberCount: parseInt(mc, 10), id };
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        slug: string;
        description: string | null;
        iconUrl: string | null;
        category: string;
        memberCount: bigint;
        lastActivityAt: Date | null;
      }>
    >`
      SELECT
        w.id,
        w.name,
        w.slug,
        w.description,
        w."iconUrl",
        w.category::text AS category,
        COUNT(wm.*)::bigint AS "memberCount",
        MAX(m."createdAt") AS "lastActivityAt"
      FROM "Workspace" w
      LEFT JOIN "WorkspaceMember" wm ON wm."workspaceId" = w.id
      LEFT JOIN "Channel" c ON c."workspaceId" = w.id AND c."deletedAt" IS NULL
      LEFT JOIN "Message" m ON m."channelId" = c.id AND m."deletedAt" IS NULL
      WHERE w."deletedAt" IS NULL
        AND w.visibility = 'PUBLIC'
        AND w.category IS NOT NULL
        AND (${cat}::text = '' OR w.category::text = ${cat}::text)
        AND (${q}::text = '' OR w.name ILIKE '%' || ${q}::text || '%')
      GROUP BY w.id
      HAVING (
        ${cursorParts === null ? null : cursorParts.memberCount}::int IS NULL
        OR COUNT(wm.*)::int < ${cursorParts === null ? 0 : cursorParts.memberCount}::int
        OR (
          COUNT(wm.*)::int = ${cursorParts === null ? 0 : cursorParts.memberCount}::int
          AND w.id::text < ${cursorParts === null ? '' : cursorParts.id}::text
        )
      )
      ORDER BY COUNT(wm.*) DESC, w.id DESC
      LIMIT ${capped + 1}
    `;
    const hasMore = rows.length > capped;
    const items = (hasMore ? rows.slice(0, capped) : rows).map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      iconUrl: r.iconUrl,
      category: r.category,
      memberCount: Number(r.memberCount),
      lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
    }));
    const nextCursor = hasMore
      ? `${items[items.length - 1].memberCount}|${items[items.length - 1].id}`
      : null;
    return { items, nextCursor };
  }

  async joinPublic(
    workspaceId: string,
    userId: string,
  ): Promise<{ workspaceId: string; alreadyMember: boolean }> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, visibility: true, deletedAt: true },
    });
    if (!ws || ws.deletedAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    if (ws.visibility !== 'PUBLIC') {
      throw new DomainError(
        ErrorCode.WORKSPACE_NOT_PUBLIC,
        'workspace is not joinable without invite',
      );
    }
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (existing) return { workspaceId, alreadyMember: true };
    await this.prisma.workspaceMember.create({
      data: { workspaceId, userId, role: WorkspaceRole.MEMBER },
    });
    return { workspaceId, alreadyMember: false };
  }

  async softDelete(workspaceId: string, actorId: string) {
    // task-013-A2 (task-034 closure): the purge worker that hard-
    // deletes post-grace rows lives at scripts/workers/
    // workspace-purge.sh (cron inside qufox-backup container,
    // daily at 05:00 UTC). This service is the soft-delete side
    // of that contract.
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
    // task-013-A2 (task-033 closure): two concurrent transferOwnership
    // calls against the same workspace would interleave under the
    // default READ COMMITTED isolation. Serializable forces the DB to
    // serialise them (losing tx retries with serialization_failure,
    // which Prisma surfaces as P2034); the TOCTOU gap between
    // findUnique and the three updates closes.
    return this.prisma.$transaction(
      async (tx) => {
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Used by guards/services that want to confirm caller is OWNER. */
  isOwner(role: string): boolean {
    return ROLE_RANK[role as SharedWorkspaceRole] === ROLE_RANK.OWNER;
  }
}
