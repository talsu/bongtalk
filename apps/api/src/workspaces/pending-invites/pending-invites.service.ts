import { Inject, Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  EMAIL_INVITE_OPAQUE_TTL_SEC,
  EMAIL_INVITE_TTL_DAYS,
  type EmailInviteResultRow,
  type EmailInviteRole,
  type InviteByEmailResponse,
  ROLE_RANK,
  type WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { MEMBER_JOINED } from '../events/workspace-events';
import { syncMemberSystemRole } from '../roles/system-role-seed';
import { ModerationService } from '../moderation/moderation.service';
import { assertWorkspaceEntryAllowed } from '../workspace-entry-gate';
import { MAIL_SENDER, type MailSender } from '../../auth/services/mail.service';
import { hashToken, makeOpaqueCode, makeRawToken, normalizeEmail } from './pending-invite-tokens';

// S68 (D13 / FR-W04a): rawToken 을 가린 단기 opaque 코드의 Redis 키 prefix. 값은
// pendingInviteId. TTL 은 EMAIL_INVITE_OPAQUE_TTL_SEC(10분). 만료 후 조회 = null → 410.
const OPAQUE_KEY = (code: string): string => `email-invite-opaque:${code}`;

// 응답에서 노출하는 워크스페이스 컬럼(WorkspaceSchema shape). invites.accept 의 select 와 동형.
const WORKSPACE_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  iconUrl: true,
  ownerId: true,
  visibility: true,
  category: true,
  joinMode: true,
  emailDomains: true,
  defaultChannelId: true,
  createdAt: true,
  deletedAt: true,
  deleteAt: true,
} as const;

@Injectable()
export class PendingInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly outbox: OutboxService,
    private readonly moderation: ModerationService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  private acceptUrl(rawToken: string, slug: string): string {
    const base = (process.env.WEB_URL ?? 'http://localhost:45173').replace(/\/$/, '');
    // rawToken 은 path 끝 segment 로 전달한다(FE EmailInviteAcceptPage 가 교환/수락에 사용).
    return `${base}/w/${slug}/email-invite/${rawToken}`;
  }

  /**
   * FR-W04: 일괄 이메일 초대(최대 50). 미가입 → WorkspacePendingInvite 행 + 안내 메일,
   * 이미 가입 → 즉시 WorkspaceMember 생성. 부분성공 — 개별 실패가 전체를 막지 않으며
   * 결과 행에 outcome/error 를 담아 반환한다. role 은 MEMBER/GUEST 만(zod 강제).
   * ★핵심 AC: DB 엔 sha256(rawToken)=tokenHash 만 저장(평문 금지).
   */
  async inviteByEmail(
    workspaceId: string,
    invitedById: string,
    emailsRaw: string[],
    role: EmailInviteRole,
    now: Date = new Date(),
  ): Promise<InviteByEmailResponse> {
    // 입력 정규화 + 중복 제거(같은 이메일을 한 배치에 두 번 적으면 한 번만 처리).
    const emails = [...new Set(emailsRaw.map((e) => normalizeEmail(e)))];
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, slug: true, deletedAt: true },
    });
    if (!workspace || workspace.deletedAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    const inviter = await this.prisma.user.findUnique({
      where: { id: invitedById },
      select: { username: true },
    });
    const inviterName = inviter?.username ?? 'qufox';
    const expiresAt = new Date(now.getTime() + EMAIL_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const results: EmailInviteResultRow[] = [];
    for (const email of emails) {
      try {
        const outcome = await this.processOne(
          { id: workspace.id, name: workspace.name, slug: workspace.slug },
          invitedById,
          inviterName,
          email,
          role,
          expiresAt,
        );
        results.push({ email, outcome });
      } catch (e) {
        // 부분성공: 개별 처리 실패는 결과 행에 담고 다음 이메일로 넘어간다(전체 중단 금지).
        const message = e instanceof Error ? e.message : 'unknown error';
        results.push({ email, outcome: 'FAILED', error: message });
      }
    }

    const sentCount = results.filter((r) => r.outcome === 'PENDING').length;
    const addedCount = results.filter((r) => r.outcome === 'ADDED_MEMBER').length;
    const failedCount = results.filter((r) => r.outcome === 'FAILED').length;
    return { results, sentCount, addedCount, failedCount };
  }

  /** 단일 이메일 1건 처리(가입자 직접 추가 / 보류 초대 생성+발송 분기). */
  private async processOne(
    workspace: { id: string; name: string; slug: string },
    invitedById: string,
    inviterName: string,
    email: string,
    role: EmailInviteRole,
    expiresAt: Date,
  ): Promise<EmailInviteResultRow['outcome']> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    // ── 이미 가입된 이메일 → 직접 WorkspaceMember 생성(보류 행 없음) ──────────────
    if (existingUser) {
      const already = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: existingUser.id } },
      });
      if (already) return 'ALREADY_MEMBER';
      // 차단된 사용자는 직접 추가하지 않는다(ban 우회 방어 — invites.accept 선례).
      if (await this.moderation.isBanned(workspace.id, existingUser.id)) {
        return 'ALREADY_MEMBER'; // 중립 — 차단 사실을 결과로 누출하지 않음.
      }
      const systemRole = role === 'GUEST' ? 'GUEST' : 'MEMBER';
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId: existingUser.id,
            role: role as WorkspaceRole,
          },
        });
        await syncMemberSystemRole(tx, workspace.id, existingUser.id, systemRole);
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: existingUser.id,
          eventType: MEMBER_JOINED,
          payload: { workspaceId: workspace.id, userId: existingUser.id, actorId: invitedById },
        });
      });
      return 'ADDED_MEMBER';
    }

    // ── 미가입 이메일 → 보류 초대 행 + 안내 메일 ──────────────────────────────────
    // 이미 활성 보류 초대가 있으면 중복 발송하지 않는다(ALREADY_PENDING).
    const existingPending = await this.prisma.workspacePendingInvite.findUnique({
      where: { workspaceId_email: { workspaceId: workspace.id, email } },
    });
    if (existingPending && !existingPending.canceledAt && !existingPending.acceptedAt) {
      return 'ALREADY_PENDING';
    }

    const rawToken = makeRawToken();
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    // 취소/수락된 기존 행이 있으면 새 토큰으로 재활성화(upsert) — @@unique([workspaceId,email]).
    await this.prisma.workspacePendingInvite.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email } },
      create: {
        id: randomUUID(),
        workspaceId: workspace.id,
        email,
        role: role as WorkspaceRole,
        tokenHash,
        invitedById,
        expiresAt,
        lastSentAt: now,
      },
      update: {
        role: role as WorkspaceRole,
        tokenHash,
        invitedById,
        expiresAt,
        acceptedAt: null,
        canceledAt: null,
        lastSentAt: now,
      },
    });
    // ★핵심 AC: 이메일에만 rawToken 을 싣는다(DB 엔 tokenHash 만 저장됨).
    await this.mail.sendWorkspaceInviteEmail(
      email,
      this.acceptUrl(rawToken, workspace.slug),
      workspace.name,
      role,
      inviterName,
    );
    return 'PENDING';
  }

  /**
   * FR-W04a 분기 ①: 미가입 초대의 rawToken 을 단기 opaque 코드로 교환한다(회원가입
   * 리다이렉트). 응답엔 opaque 코드만 실려 rawToken 은 URL/로그에 평문 노출되지 않는다.
   * ★핵심 AC: 만료/무효 토큰은 EMAIL_INVITE_EXPIRED(410)/EMAIL_INVITE_TOKEN_INVALID(400).
   */
  async exchangeToken(rawToken: string, now: Date = new Date()) {
    const pending = await this.loadActiveByToken(rawToken, now);
    const opaqueCode = makeOpaqueCode();
    await this.redis.set(OPAQUE_KEY(opaqueCode), pending.id, 'EX', EMAIL_INVITE_OPAQUE_TTL_SEC);
    const ws = await this.prisma.workspace.findUnique({
      where: { id: pending.workspaceId },
      select: { name: true },
    });
    return {
      opaqueCode,
      email: pending.email,
      workspaceName: ws?.name ?? '',
      expiresAt: new Date(now.getTime() + EMAIL_INVITE_OPAQUE_TTL_SEC * 1000).toISOString(),
    };
  }

  /**
   * FR-W04a 분기 ①(가입 후): opaque 코드로 보류 초대를 검증해 자동 수락한다. 회원가입
   * 직후 호출되며, userId/userEmail/emailVerified 는 컨트롤러가 JWT 에서 로드해 넘긴다.
   */
  async acceptByOpaque(
    opaqueCode: string,
    actor: { userId: string; userEmail: string; emailVerified: boolean },
    now: Date = new Date(),
  ) {
    const pendingId = await this.redis.get(OPAQUE_KEY(opaqueCode));
    if (!pendingId) {
      // opaque 만료(10분 경과)/무효 → 410(한때 유효했으나 소멸 — FR-W04a ④와 동일 계열).
      throw new DomainError(ErrorCode.EMAIL_INVITE_EXPIRED, 'invite exchange code expired');
    }
    const pending = await this.prisma.workspacePendingInvite.findUnique({
      where: { id: pendingId },
    });
    if (!pending) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_TOKEN_INVALID, 'invite not found');
    }
    const result = await this.acceptPending(pending, actor, now);
    // 일회용 — 수락 성공 후 opaque 코드를 즉시 폐기한다(재사용 차단).
    await this.redis.del(OPAQUE_KEY(opaqueCode));
    return result;
  }

  /**
   * FR-W04a 분기 ②③: rawToken 직접 수락(가입+이메일 일치 즉시 / 다른 계정 로그인).
   * 컨트롤러가 로그인 사용자의 userId/email/emailVerified 를 넘긴다.
   */
  async acceptByToken(
    rawToken: string,
    actor: { userId: string; userEmail: string; emailVerified: boolean },
    now: Date = new Date(),
  ) {
    const pending = await this.loadActiveByToken(rawToken, now);
    return this.acceptPending(pending, actor, now);
  }

  /**
   * FR-W04a: rawToken → sha256 대조 + 만료/취소 검사로 활성 보류 초대를 로드한다.
   * ★핵심 AC: 저장된 tokenHash 와 sha256(rawToken) 대조(평문 비교 없음). 미존재/취소 →
   * 400 INVALID, 만료 → 410 EXPIRED, 이미수락 → 409 ALREADY_ACCEPTED.
   */
  private async loadActiveByToken(rawToken: string, now: Date) {
    const tokenHash = hashToken(rawToken);
    const pending = await this.prisma.workspacePendingInvite.findUnique({
      where: { tokenHash },
    });
    if (!pending || pending.canceledAt) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_TOKEN_INVALID, 'invalid invite token');
    }
    if (pending.acceptedAt) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_ALREADY_ACCEPTED, 'invite already accepted');
    }
    if (pending.expiresAt.getTime() <= now.getTime()) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_EXPIRED, 'invite expired');
    }
    return pending;
  }

  /**
   * 공통 수락 본체: role 대조 → 진입 게이트(emailVerified + emailDomains) → ban 검사 →
   * 멤버 생성 + acceptedAt CAS. role 대조(token role ↔ DB role)는 loadActiveByToken 이
   * 이미 단일 행을 읽었으므로 행의 role 이 곧 DB role 이다. 여기서는 actor 가 들고 온
   * (URL/메일에서 추론된) 역할이 없으므로, pending.role 을 그대로 진실로 쓰되 ROLE_RANK
   * 가 직접 초대 가능 범위(MEMBER/GUEST)를 벗어나면 위조로 간주해 400 으로 거부한다.
   */
  private async acceptPending(
    pending: {
      id: string;
      workspaceId: string;
      role: WorkspaceRole;
      acceptedAt: Date | null;
    },
    actor: { userId: string; userEmail: string; emailVerified: boolean },
    now: Date,
  ) {
    // role 대조: 직접 초대 역할은 MEMBER/GUEST 만 유효하다. 그 외(ADMIN+)면 위조/변조로
    // 간주해 400 으로 거부한다(EMAIL_INVITE_ROLE_MISMATCH).
    if (pending.role !== WorkspaceRole.MEMBER && pending.role !== WorkspaceRole.GUEST) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_ROLE_MISMATCH, 'invite role mismatch');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: pending.workspaceId },
      select: WORKSPACE_SELECT,
    });
    if (!workspace || workspace.deletedAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }

    const already = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: pending.workspaceId, userId: actor.userId } },
    });
    if (already) {
      // 이미 멤버면 보류 초대를 수락 처리(acceptedAt)하고 멱등 성공으로 본다.
      await this.markAccepted(pending.id, now);
      return { workspace, alreadyMember: true };
    }

    if (await this.moderation.isBanned(pending.workspaceId, actor.userId)) {
      // 차단 사실 누출 방지 — 초대 미존재와 동일 중립 코드.
      throw new DomainError(ErrorCode.EMAIL_INVITE_TOKEN_INVALID, 'invalid invite token');
    }

    // 진입 게이트(emailVerified + emailDomains). invites.accept / joinPublic 선례 일관.
    assertWorkspaceEntryAllowed({
      emailVerified: actor.emailVerified,
      userEmail: actor.userEmail,
      emailDomains: workspace.emailDomains,
    });

    const systemRole = pending.role === WorkspaceRole.GUEST ? 'GUEST' : 'MEMBER';
    try {
      await this.prisma.$transaction(async (tx) => {
        // acceptedAt CAS — 동시 수락 레이스에서 한쪽만 성공(이미 수락됐으면 count=0).
        const accepted = await tx.workspacePendingInvite.updateMany({
          where: { id: pending.id, acceptedAt: null, canceledAt: null },
          data: { acceptedAt: now },
        });
        if (accepted.count === 0) {
          throw new DomainError(ErrorCode.EMAIL_INVITE_ALREADY_ACCEPTED, 'invite already accepted');
        }
        await tx.workspaceMember.create({
          data: {
            workspaceId: pending.workspaceId,
            userId: actor.userId,
            role: pending.role,
          },
        });
        await syncMemberSystemRole(tx, pending.workspaceId, actor.userId, systemRole);
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: actor.userId,
          eventType: MEMBER_JOINED,
          payload: {
            workspaceId: pending.workspaceId,
            userId: actor.userId,
            actorId: actor.userId,
          },
        });
      });
    } catch (e) {
      // 동시 수락 패자(멤버 복합 PK 충돌)는 멱등 성공으로 처리한다(invites.accept 선례).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.markAccepted(pending.id, now);
        return { workspace, alreadyMember: true };
      }
      throw e;
    }
    return { workspace, alreadyMember: false };
  }

  private async markAccepted(id: string, now: Date): Promise<void> {
    await this.prisma.workspacePendingInvite.updateMany({
      where: { id, acceptedAt: null, canceledAt: null },
      data: { acceptedAt: now },
    });
  }

  /**
   * FR-W18: 활성 보류 초대 목록(ADMIN+). 취소/수락분은 제외하고 만료 여부(expired)를
   * 서버가 계산해 내려준다(FE 재계산 방지). tokenHash 는 절대 응답에 싣지 않는다.
   */
  async listPending(workspaceId: string, now: Date = new Date()) {
    const rows = await this.prisma.workspacePendingInvite.findMany({
      where: { workspaceId, canceledAt: null, acceptedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { invitedBy: { select: { id: true, username: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      email: r.email,
      role: r.role as SharedWorkspaceRole,
      expiresAt: r.expiresAt.toISOString(),
      lastSentAt: r.lastSentAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      expired: r.expiresAt.getTime() <= now.getTime(),
      invitedBy: r.invitedBy ? { id: r.invitedBy.id, username: r.invitedBy.username } : null,
    }));
  }

  /** FR-W18: 보류 초대 연장(+30일). 활성 행만 대상이며 lastSentAt 은 유지한다. */
  async extendPending(workspaceId: string, pendingId: string, now: Date = new Date()) {
    const newExpiry = new Date(now.getTime() + EMAIL_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.prisma.workspacePendingInvite.updateMany({
      where: { id: pendingId, workspaceId, canceledAt: null, acceptedAt: null },
      data: { expiresAt: newExpiry },
    });
    if (result.count === 0) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_NOT_FOUND, 'pending invite not found');
    }
  }

  /**
   * FR-W18: 보류 초대 재발송. 새 rawToken 을 발급(이전 토큰 무효화)하고 expiresAt/lastSentAt
   * 을 갱신한 뒤 안내 메일을 다시 보낸다. ★핵심 AC: 새 rawToken 도 sha256 만 DB 저장.
   */
  async resendPending(workspaceId: string, pendingId: string, now: Date = new Date()) {
    const pending = await this.prisma.workspacePendingInvite.findFirst({
      where: { id: pendingId, workspaceId, canceledAt: null, acceptedAt: null },
    });
    if (!pending) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_NOT_FOUND, 'pending invite not found');
    }
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, slug: true },
    });
    const inviter = await this.prisma.user.findUnique({
      where: { id: pending.invitedById },
      select: { username: true },
    });
    const rawToken = makeRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(now.getTime() + EMAIL_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.workspacePendingInvite.update({
      where: { id: pending.id },
      data: { tokenHash, expiresAt, lastSentAt: now },
    });
    await this.mail.sendWorkspaceInviteEmail(
      pending.email,
      this.acceptUrl(rawToken, workspace?.slug ?? ''),
      workspace?.name ?? '',
      pending.role,
      inviter?.username ?? 'qufox',
    );
  }

  /** FR-W18: 보류 초대 취소(soft). canceledAt 을 찍어 목록/수락에서 제외한다. */
  async cancelPending(workspaceId: string, pendingId: string, now: Date = new Date()) {
    const result = await this.prisma.workspacePendingInvite.updateMany({
      where: { id: pendingId, workspaceId, canceledAt: null, acceptedAt: null },
      data: { canceledAt: now },
    });
    if (result.count === 0) {
      throw new DomainError(ErrorCode.EMAIL_INVITE_NOT_FOUND, 'pending invite not found');
    }
  }

  /** ADMIN 이상 게이트 헬퍼(컨트롤러가 @Roles('ADMIN') 로도 강제하지만 일관성 위해 보조). */
  static requiresAdmin(role: SharedWorkspaceRole): boolean {
    return ROLE_RANK[role] >= ROLE_RANK.ADMIN;
  }
}
