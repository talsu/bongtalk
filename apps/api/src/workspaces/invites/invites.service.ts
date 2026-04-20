import { Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { CreateInviteRequest } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import {
  INVITE_ACCEPTED,
  INVITE_CREATED,
  INVITE_REVOKED,
  MEMBER_JOINED,
} from '../events/workspace-events';

function codeBytes(): number {
  const n = Number(process.env.INVITE_CODE_BYTES ?? 16);
  return Number.isFinite(n) && n >= 12 ? n : 16;
}

function makeCode(): string {
  return randomBytes(codeBytes()).toString('base64url');
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async create(workspaceId: string, createdById: string, input: CreateInviteRequest) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const invite = await tx.invite.create({
            data: {
              id: randomUUID(),
              workspaceId,
              code: makeCode(),
              createdById,
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
              maxUses: input.maxUses ?? null,
            },
          });
          await this.outbox.record(tx, {
            aggregateType: 'invite',
            aggregateId: invite.id,
            eventType: INVITE_CREATED,
            payload: { workspaceId, inviteId: invite.id, actorId: createdById },
          });
          return invite;
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          attempt < 2
        ) {
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable — collision retry exhausted');
  }

  async list(workspaceId: string) {
    return this.prisma.invite.findMany({
      where: { workspaceId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(workspaceId: string, inviteId: string, actorId: string) {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.invite.updateMany({
        where: { id: inviteId, workspaceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) {
        throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
      }
      await this.outbox.record(tx, {
        aggregateType: 'invite',
        aggregateId: inviteId,
        eventType: INVITE_REVOKED,
        payload: { workspaceId, inviteId, actorId },
      });
    });
  }

  /** Public preview — no auth. Hides workspace details beyond what a joiner needs.
   *  Callers (controller) must apply a per-IP rate limit before invoking this. */
  async preview(code: string) {
    const invite = await this.prisma.invite.findUnique({
      where: { code },
      include: {
        workspace: { select: { name: true, slug: true, iconUrl: true, deletedAt: true } },
      },
    });
    if (!invite || invite.workspace.deletedAt) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }
    if (invite.revokedAt) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite revoked');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.INVITE_EXPIRED, 'invite expired');
    }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      throw new DomainError(ErrorCode.INVITE_EXHAUSTED, 'invite fully used');
    }
    return {
      workspace: {
        name: invite.workspace.name,
        slug: invite.workspace.slug,
        iconUrl: invite.workspace.iconUrl,
      },
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      usesRemaining:
        invite.maxUses !== null ? Math.max(0, invite.maxUses - invite.usedCount) : null,
    };
  }

  /**
   * Race-safe accept — atomic CAS on `usedCount` followed by member insert.
   * A concurrent-accept loser (two tabs from the same user) refunds the seat
   * it just consumed and surfaces ALREADY_MEMBER instead of a raw 500.
   */
  async accept(code: string, userId: string) {
    const existing = await this.prisma.invite.findUnique({
      where: { code },
      select: { id: true, workspaceId: true, revokedAt: true, expiresAt: true, maxUses: true },
    });
    if (!existing || existing.revokedAt) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }
    if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.INVITE_EXPIRED, 'invite expired');
    }

    const already = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: existing.workspaceId, userId } },
    });
    if (already) {
      throw new DomainError(
        ErrorCode.WORKSPACE_ALREADY_MEMBER,
        'you are already a member of this workspace',
      );
    }

    const now = new Date();
    // Compare-and-swap is intentionally OUTSIDE the transaction so that the
    // atomic UPDATE commits as a single statement and visible races between
    // concurrent requests are resolved by row-level locking.
    const casResult = await this.prisma.$executeRawUnsafe<number>(
      `UPDATE "Invite"
         SET "usedCount" = "usedCount" + 1
       WHERE code = $1
         AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > $2)
         AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`,
      code,
      now,
    );
    if (casResult === 0) {
      // Task-013-A (task-032 closure): the pre-CAS findUnique catches
      // NOT_FOUND + REVOKED + EXPIRED; the CAS itself catches
      // EXHAUSTED + any race where the invite was revoked between the
      // findUnique and the UPDATE. A second findUnique tells the two
      // apart so we surface a precise error instead of always
      // INVITE_EXHAUSTED.
      const post = await this.prisma.invite.findUnique({
        where: { code },
        select: { revokedAt: true, expiresAt: true, maxUses: true, usedCount: true },
      });
      if (!post) {
        throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite vanished mid-accept');
      }
      if (post.revokedAt) {
        throw new DomainError(ErrorCode.INVITE_REVOKED, 'invite was revoked');
      }
      if (post.expiresAt && post.expiresAt.getTime() <= Date.now()) {
        throw new DomainError(ErrorCode.INVITE_EXPIRED, 'invite expired');
      }
      // Fell through → exhausted is the remaining case.
      throw new DomainError(ErrorCode.INVITE_EXHAUSTED, 'invite fully used');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.create({
          data: { workspaceId: existing.workspaceId, userId, role: WorkspaceRole.MEMBER },
        });
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: userId,
          eventType: MEMBER_JOINED,
          payload: { workspaceId: existing.workspaceId, userId, actorId: userId },
        });
        await this.outbox.record(tx, {
          aggregateType: 'invite',
          aggregateId: existing.id,
          eventType: INVITE_ACCEPTED,
          payload: {
            workspaceId: existing.workspaceId,
            inviteId: existing.id,
            actorId: userId,
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.$executeRawUnsafe(
          `UPDATE "Invite" SET "usedCount" = "usedCount" - 1 WHERE code = $1 AND "usedCount" > 0`,
          code,
        );
        throw new DomainError(
          ErrorCode.WORKSPACE_ALREADY_MEMBER,
          'you are already a member of this workspace',
        );
      }
      throw e;
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: existing.workspaceId },
    });
    return workspace!;
  }
}
