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
// S61 fix-forward (security A-2): 초대 수락 가입 시 시스템 MemberRole 동기.
import { syncMemberSystemRole } from '../roles/system-role-seed';
// S63 (FR-RM06): 초대 수락 시 차단된 userId 재가입 거부.
import { ModerationService } from '../moderation/moderation.service';
// S66 (D13 / FR-W05a): 초대 수락 시점 emailVerified + emailDomains 진입 게이트.
import { assertWorkspaceEntryAllowed } from '../workspace-entry-gate';

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
    // S63 (FR-RM06): 차단된 userId 의 초대 수락 재가입을 거부하기 위한 차단 조회.
    private readonly moderation: ModerationService,
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
  async accept(
    code: string,
    userId: string,
    // S66 (D13 / FR-W05a): 초대 수락 시점 진입 게이트(emailVerified + emailDomains).
    // 컨트롤러가 JWT 에서 로드한 본인 emailVerified/email 을 넘긴다. 게이트는 워크스페이스
    // emailDomains 와 함께 invite 조회 직후·CAS 전에 적용한다(미인증/도메인 불일치 사용자가
    // 초대 좌석을 소모하지 않게 함).
    actor: { emailVerified: boolean; userEmail: string },
  ) {
    const existing = await this.prisma.invite.findUnique({
      where: { code },
      select: {
        id: true,
        workspaceId: true,
        revokedAt: true,
        expiresAt: true,
        maxUses: true,
        // S66 (D13 / FR-W05a): 도메인 게이트용 화이트리스트.
        workspace: { select: { emailDomains: true } },
      },
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

    // S63 (FR-RM06): 차단된 userId 는 초대를 받아도 재진입할 수 없다. CAS(usedCount
    // 증가) 전에 검사해 차단 사용자가 초대 좌석을 소모하지 않게 한다(404 — 차단 사실을
    // 누출하지 않도록 초대 미존재와 동일한 중립 코드로 거부).
    if (await this.moderation.isBanned(existing.workspaceId, userId)) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }

    // S66 (D13 / FR-W05a): emailVerified 재확인 직후 emailDomains exact-match 검증.
    // emailDomains 빈 배열이면 도메인 게이트 통과(제한 없음).
    // S66 fix-forward (review m4): 진입 게이트를 already-member·ban 검사 *뒤*로 옮겨
    // joinPublic 과 순서를 통일한다 — 이미 멤버이거나 차단된 사용자는 게이트 평가 전에
    // 각자의 정확한 에러(ALREADY_MEMBER / 중립 404)를 받는다(멤버는 게이트 면제 의미 명확화).
    assertWorkspaceEntryAllowed({
      emailVerified: actor.emailVerified,
      userEmail: actor.userEmail,
      emailDomains: existing.workspace.emailDomains,
    });

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
        // S61 fix-forward (security A-2 · MemberRole desync): 가입 트랜잭션에서 MEMBER
        // 시스템 MemberRole 을 시드한다(enum ↔ 시스템 Role 동기 불변식). 누락 시
        // ADMIN 승격 후에도 역할 생성/부여가 전부 거부된다.
        await syncMemberSystemRole(tx, existing.workspaceId, userId, 'MEMBER');
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
