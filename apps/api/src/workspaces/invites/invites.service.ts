import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { CreateInviteRequest } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
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
    private readonly emitter: EventEmitter2,
  ) {}

  async create(
    workspaceId: string,
    createdById: string,
    input: CreateInviteRequest,
  ) {
    // Collision retry: 3 attempts (16 random bytes → collision is cosmic-ray territory).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const invite = await this.prisma.invite.create({
          data: {
            id: randomUUID(),
            workspaceId,
            code: makeCode(),
            createdById,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            maxUses: input.maxUses ?? null,
          },
        });
        this.emitter.emit(INVITE_CREATED, {
          workspaceId,
          inviteId: invite.id,
          actorId: createdById,
        });
        return invite;
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
    const result = await this.prisma.invite.updateMany({
      where: { id: inviteId, workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }
    this.emitter.emit(INVITE_REVOKED, { workspaceId, inviteId, actorId });
  }

  /** Public preview — no auth. Hides workspace details beyond what a joiner needs. */
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
   * Race-safe accept. Strategy:
   *   - Single `updateMany` increments usedCount only when the invite is still
   *     valid (not revoked, not expired, and usedCount < maxUses). This is a
   *     **compare-and-swap** backed by the DB, so 10 concurrent callers see at
   *     most `maxUses` successes without taking a row lock.
   *   - On success, upsert the WorkspaceMember.
   *   - If the user is already a member, we short-circuit BEFORE the CAS so we
   *     do not consume a seat.
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
    // Compare-and-swap: increment only while usedCount<maxUses OR maxUses is null.
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
      throw new DomainError(ErrorCode.INVITE_EXHAUSTED, 'invite fully used');
    }

    try {
      await this.prisma.workspaceMember.create({
        data: { workspaceId: existing.workspaceId, userId, role: WorkspaceRole.MEMBER },
      });
    } catch (e) {
      // Race: two concurrent accepts from the same user can both pass the
      // pre-check and both consume a seat in the CAS. Only one member-create
      // succeeds (P2002 on the composite PK); the loser must refund the seat
      // it just consumed and surface ALREADY_MEMBER instead of a raw 500.
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

    this.emitter.emit(MEMBER_JOINED, {
      workspaceId: existing.workspaceId,
      userId,
      actorId: userId,
    });
    this.emitter.emit(INVITE_ACCEPTED, {
      workspaceId: existing.workspaceId,
      inviteId: existing.id,
      actorId: userId,
    });

    return workspace!;
  }
}
