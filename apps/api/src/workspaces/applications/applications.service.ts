import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ApplicationStatus, Prisma, WorkspaceRole } from '@prisma/client';
import {
  APPLICATION_REAPPLY_COOLDOWN_MS,
  ROLE_RANK,
  type ApplicationAnswer,
  type ProcessApplicationAction,
  type WorkspaceMemberApplication as WorkspaceMemberApplicationDto,
  type WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { assertWorkspaceEntryAllowed } from '../workspace-entry-gate';
import { ModerationService } from '../moderation/moderation.service';
// S72 (D13 / FR-W22): 가입 신청(APPLY) IP soft-block — 차단 IP 신청은 즉시 403 차단.
import { IpSoftBlockService } from '../moderation/ip-soft-block.service';
import { syncMemberSystemRole } from '../roles/system-role-seed';
import {
  MEMBER_APPLICATION_RECEIVED,
  MEMBER_APPLICATION_REVIEWED,
  MEMBER_JOINED,
} from '../events/workspace-events';
import { DirectMessagesService } from '../../channels/direct-messages/direct-messages.service';

// Prisma enum 값(대문자) → wire status(소문자). reviewed wire 는 approved/rejected/interview
// 3종만 노출한다(PENDING/WITHDRAWN 은 reviewed 이벤트를 발생시키지 않음).
const WIRE_STATUS: Partial<Record<ApplicationStatus, 'approved' | 'rejected' | 'interview'>> = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  INTERVIEW: 'interview',
};

type ApplicationRow = {
  id: string;
  workspaceId: string;
  applicantId: string;
  status: ApplicationStatus;
  answers: Prisma.JsonValue;
  reviewedById: string | null;
  reviewNote: string | null;
  interviewChannelId: string | null;
  createdAt: Date;
  updatedAt: Date;
  applicant?: { id: string; username: string } | null;
};

/**
 * S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) 도메인 서비스.
 *
 * - submit: emailVerified + emailDomains 진입 게이트(S66 재사용) + ban 체크(S63) + PENDING
 *   중복 409 + 질문 최대 5개(Zod) + REJECTED 24h cooldown. WITHDRAWN/REJECTED 행은 PENDING
 *   으로 되살려(UPDATE) @@unique 충돌을 피한다.
 * - list(ADMIN+): status 필터 목록 + 신청자 표시 정보 best-effort 조인.
 * - me: 본인 최신 신청 1건(없으면 null) — WS 끊김 시 30초 polling fallback 용.
 * - process(approve/reject/interview): approve=WorkspaceMember 생성 tx + MEMBER_JOINED outbox,
 *   reject=reviewNote 기록, interview=1:1 DM createInterviewDm + interviewChannelId + 알림.
 *   approve/interview 는 ADMIN+(MODERATOR 거부 403), reject 는 MODERATOR+. 모두 application.
 *   reviewed outbox(신청자 user 룸 fanout) 를 남긴다.
 * - withdraw: PENDING → WITHDRAWN(본인). PENDING 외 상태는 409.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly moderation: ModerationService,
    // S72 (D13 / FR-W22): 신청 제출 시 차단 IP soft-block(APPLY → 즉시 403 차단).
    private readonly ipSoftBlock: IpSoftBlockService,
    // 인터뷰 1:1 DM 자동 생성(createInterviewDm). ChannelsModule ↔ WorkspacesModule 양방향
    // 순환은 WorkspacesModule 이 이미 forwardRef(ChannelsModule) 로 끊어 둔다.
    @Inject(forwardRef(() => DirectMessagesService))
    private readonly dms: DirectMessagesService,
  ) {}

  /**
   * FR-W06: 가입 신청 제출. 워크스페이스는 slug 로 해석한다(신청자는 아직 멤버가 아니므로
   * WorkspaceMemberGuard 를 걸 수 없다 — pending-invites accept 와 동일 패턴).
   */
  async submit(args: {
    slug: string;
    // S72 (D13 / FR-W22): clientIp(req.ip 계열)로 APPLY IP soft-block 대조(차단 IP → 403).
    applicant: {
      userId: string;
      emailVerified: boolean;
      userEmail: string;
      clientIp?: string | null;
    };
    answers: ApplicationAnswer[];
  }): Promise<WorkspaceMemberApplicationDto> {
    const { slug } = args;
    const { userId, emailVerified, userEmail } = args.applicant;
    const ws = await this.prisma.workspace.findUnique({
      where: { slug },
      select: { id: true, joinMode: true, emailDomains: true, deletedAt: true },
    });
    if (!ws || ws.deletedAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    // joinMode 가 APPLY 가 아니면 신청 대상이 아니다(PUBLIC=즉시 가입 / PRIVATE=초대 전용).
    if (ws.joinMode !== 'APPLY') {
      throw new DomainError(
        ErrorCode.APPLICATION_NOT_APPLICABLE,
        'this workspace does not accept applications',
      );
    }
    // 이미 멤버이면 신청 불가(멱등 — 충돌 대신 명확한 409).
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId } },
      select: { userId: true },
    });
    if (member) {
      throw new DomainError(ErrorCode.WORKSPACE_ALREADY_MEMBER, 'already a member');
    }
    // 차단된 userId 는 신청도 불가(중립 404 — 차단 사실 누출 방지, joinPublic/accept 선례).
    if (await this.moderation.isBanned(ws.id, userId)) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    // emailVerified 재확인 + emailDomains exact-match(빈 배열이면 제한 없음).
    assertWorkspaceEntryAllowed({ emailVerified, userEmail, emailDomains: ws.emailDomains });

    // S72 (D13 / FR-W22): IP soft-block. 신청은 APPLY 메커니즘이라 차단 IP(BannedMember.
    // ipHash) 매칭 시 즉시 403(중립 APPLICATION_NOT_APPLICABLE)으로 거부한다 — 승인 게이트가
    // 있어 NAT 오탐의 피해가 작고, 차단 사용자의 우회 신청 경로를 IP 단계에서 닫는다. 미상
    // IP 는 무동작(통과). userId-ban 검사 뒤에 둬 차단 사용자는 그 경로의 중립 404 를 먼저 받는다.
    await this.ipSoftBlock.assertNotIpBlocked({
      workspaceId: ws.id,
      userId,
      clientIp: args.applicant.clientIp,
      mechanism: 'APPLY',
    });

    // perf(MINOR): PENDING/INTERVIEW/REJECTED 개별 findUnique 3회 대신 (workspaceId,
    // applicantId) 의 비-WITHDRAWN 활성 상태를 한 번에 조회한 뒤 분기한다((workspaceId,
    // status, createdAt) 인덱스가 커버). 같은 조합당 status 별 최대 1행이라 결과는 최대 3행.
    const blocking = await this.prisma.workspaceMemberApplication.findMany({
      where: {
        workspaceId: ws.id,
        applicantId: userId,
        status: {
          in: [ApplicationStatus.PENDING, ApplicationStatus.INTERVIEW, ApplicationStatus.REJECTED],
        },
      },
      select: { id: true, status: true, updatedAt: true },
    });
    const byStatus = new Map(blocking.map((r) => [r.status, r]));

    // 기존 PENDING 신청이 있으면 409(중복 신청 금지 — DB 유니크 충돌 전 명확한 에러).
    if (byStatus.has(ApplicationStatus.PENDING)) {
      throw new DomainError(
        ErrorCode.APPLICATION_PENDING_EXISTS,
        'you already have a pending application',
      );
    }
    // INTERVIEW 진행 중인 신청이 있으면 중복 신청 금지(인터뷰 후 동일 신청서가 재처리됨).
    if (byStatus.has(ApplicationStatus.INTERVIEW)) {
      throw new DomainError(
        ErrorCode.APPLICATION_PENDING_EXISTS,
        'your application is under interview review',
      );
    }

    // REJECTED 후 24h cooldown — 가장 최근 REJECTED 신청의 updatedAt 기준(코드 정본).
    const rejected = byStatus.get(ApplicationStatus.REJECTED);
    if (rejected) {
      const elapsed = Date.now() - rejected.updatedAt.getTime();
      if (elapsed < APPLICATION_REAPPLY_COOLDOWN_MS) {
        throw new DomainError(
          ErrorCode.APPLICATION_COOLDOWN,
          'you can re-apply 24 hours after a rejection',
          { retryAfterMs: APPLICATION_REAPPLY_COOLDOWN_MS - elapsed },
        );
      }
    }

    // 재신청은 WITHDRAWN/REJECTED 행을 PENDING 으로 되살려 @@unique(ws,applicant,PENDING)
    // 충돌을 피한다. 없으면 신규 생성. 어느 쪽이든 PENDING 행 1개를 반환한다.
    const answersJson = args.answers as unknown as Prisma.InputJsonValue;
    let created: ApplicationRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const reusable = await tx.workspaceMemberApplication.findFirst({
          where: {
            workspaceId: ws.id,
            applicantId: userId,
            status: { in: [ApplicationStatus.WITHDRAWN, ApplicationStatus.REJECTED] },
          },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });
        const row = reusable
          ? await tx.workspaceMemberApplication.update({
              where: { id: reusable.id },
              data: {
                status: ApplicationStatus.PENDING,
                answers: answersJson,
                reviewedById: null,
                reviewNote: null,
                interviewChannelId: null,
              },
            })
          : await tx.workspaceMemberApplication.create({
              data: {
                workspaceId: ws.id,
                applicantId: userId,
                status: ApplicationStatus.PENDING,
                answers: answersJson,
              },
            });
        // 신청자 표시명(ADMIN 패널 토스트/목록). best-effort.
        const applicant = await tx.user.findUnique({
          where: { id: userId },
          select: { username: true },
        });
        await this.outbox.record(tx, {
          aggregateType: 'application',
          aggregateId: row.id,
          eventType: MEMBER_APPLICATION_RECEIVED,
          payload: {
            workspaceId: ws.id,
            applicationId: row.id,
            applicantId: userId,
            applicantName: applicant?.username ?? '',
          },
        });
        return row;
      });
    } catch (e) {
      // M-2: 두 요청이 동시에 위 선조회를 통과하면 create 가 @@unique(workspaceId,
      // applicantId,PENDING) 에서 P2002 로 충돌한다(동시 신청). 500 대신 명확한
      // APPLICATION_PENDING_EXISTS(409)로 변환한다(선조회 409 와 동일 의미).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(
          ErrorCode.APPLICATION_PENDING_EXISTS,
          'you already have a pending application',
        );
      }
      throw e;
    }

    return this.toDto(created);
  }

  /** FR-W06: ADMIN 신청 목록(status 필터 선택). 신청자 표시 정보 best-effort 조인. */
  async list(args: {
    workspaceId: string;
    status?: ApplicationStatus;
  }): Promise<WorkspaceMemberApplicationDto[]> {
    const where: Prisma.WorkspaceMemberApplicationWhereInput = {
      workspaceId: args.workspaceId,
    };
    if (args.status) where.status = args.status;
    const rows = await this.prisma.workspaceMemberApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { applicant: { select: { id: true, username: true } } },
    });
    return rows.map((r) => this.toDto(r));
  }

  /** FR-W06a: 본인 최신 신청 1건(없으면 null). WS 끊김 시 30초 polling fallback 용. */
  async myApplication(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberApplicationDto | null> {
    const row = await this.prisma.workspaceMemberApplication.findFirst({
      where: { workspaceId, applicantId: userId },
      orderBy: { updatedAt: 'desc' },
    });
    return row ? this.toDto(row) : null;
  }

  /**
   * FR-W06: 신청 처리(approve/reject/interview). approve/interview 는 ADMIN+(MODERATOR 거부),
   * reject 는 MODERATOR+. 대상 신청은 PENDING 또는 INTERVIEW 상태여야 한다(그 외 409).
   */
  async process(args: {
    workspaceId: string;
    applicationId: string;
    actorId: string;
    actorRole: SharedWorkspaceRole;
    action: ProcessApplicationAction;
    reviewNote?: string;
  }): Promise<WorkspaceMemberApplicationDto> {
    const { workspaceId, applicationId, actorId, actorRole, action, reviewNote } = args;

    // approve/interview 권한: ADMIN+ 만(MODERATOR 는 reject 만 가능).
    if (
      (action === 'approve' || action === 'interview') &&
      ROLE_RANK[actorRole] < ROLE_RANK.ADMIN
    ) {
      throw new DomainError(
        ErrorCode.APPLICATION_FORBIDDEN,
        'approve/interview require ADMIN or higher',
      );
    }

    const app = await this.prisma.workspaceMemberApplication.findFirst({
      where: { id: applicationId, workspaceId },
    });
    if (!app) {
      throw new DomainError(ErrorCode.APPLICATION_NOT_FOUND, 'application not found');
    }
    // PENDING/INTERVIEW 만 처리 가능(APPROVED/REJECTED/WITHDRAWN 은 종결 상태).
    if (app.status !== ApplicationStatus.PENDING && app.status !== ApplicationStatus.INTERVIEW) {
      throw new DomainError(
        ErrorCode.APPLICATION_INVALID_STATE,
        'application is not in a reviewable state',
      );
    }

    if (action === 'approve') return this.approve(app, actorId);
    if (action === 'reject') return this.reject(app, actorId, reviewNote);
    return this.interview(app, actorId);
  }

  /**
   * approve: ban 재확인(M-1) + WorkspaceMember 생성 + MEMBER 시스템 역할 동기 +
   * MEMBER_JOINED + reviewed(approved). 모두 한 트랜잭션.
   */
  private async approve(
    app: ApplicationRow,
    actorId: string,
  ): Promise<WorkspaceMemberApplicationDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      // M-1: submit↔approve 사이에 신청자가 차단(ban)됐는지 트랜잭션 내부에서 재확인한다.
      // submit 시점엔 미차단이어도 검토 대기 중 ADMIN 이 ban 할 수 있으므로, 차단 사용자를
      // approve 로 멤버화하는 우회를 막는다(joinPublic/accept 의 ban 게이트 정합 — 중립
      // 404 로 차단 사실 누출 방지). emailVerified 는 JWT 가 매요청 DB 로드라 재확인 불요.
      const banned = await tx.bannedMember.findUnique({
        where: { workspaceId_userId: { workspaceId: app.workspaceId, userId: app.applicantId } },
        select: { userId: true },
      });
      if (banned) {
        throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
      }
      const row = await tx.workspaceMemberApplication.update({
        where: { id: app.id },
        data: { status: ApplicationStatus.APPROVED, reviewedById: actorId },
      });
      // 멤버 생성(중복이면 P2002 — 동시 승인/이미 멤버는 멱등 무시). MemberRole 동기는
      // joinPublic/accept 와 동일 불변식(누락 시 역할 관리 전부 거부).
      try {
        await tx.workspaceMember.create({
          data: {
            workspaceId: app.workspaceId,
            userId: app.applicantId,
            role: WorkspaceRole.MEMBER,
          },
        });
        await syncMemberSystemRole(tx, app.workspaceId, app.applicantId, 'MEMBER');
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) {
          throw e;
        }
        // 이미 멤버(동시 승인/초대 수락 레이스) → 신청만 APPROVED 로 마감(멱등).
      }
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: app.applicantId,
        eventType: MEMBER_JOINED,
        payload: { workspaceId: app.workspaceId, userId: app.applicantId, actorId },
      });
      await this.recordReviewed(tx, row);
      return row;
    });
    return this.toDto(updated);
  }

  /** reject: reviewNote 기록 + reviewed(rejected). 24h cooldown 은 재신청 시 submit 이 검사. */
  private async reject(
    app: ApplicationRow,
    actorId: string,
    reviewNote?: string,
  ): Promise<WorkspaceMemberApplicationDto> {
    const note = normalizeNote(reviewNote);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.workspaceMemberApplication.update({
        where: { id: app.id },
        data: { status: ApplicationStatus.REJECTED, reviewedById: actorId, reviewNote: note },
      });
      await this.recordReviewed(tx, row);
      return row;
    });
    return this.toDto(updated);
  }

  /**
   * interview: 신청자와 1:1 DM 자동 생성(interviewChannelId 기록) + reviewed(interview).
   * DM 생성은 트랜잭션 밖에서 먼저 한다(채널 생성은 별도 commit — createInterviewDm 가
   * 자체 tx + 멱등). 그 channelId 를 신청 상태 UPDATE + reviewed outbox 와 함께 한 commit 에
   * 기록한다.
   */
  private async interview(
    app: ApplicationRow,
    actorId: string,
  ): Promise<WorkspaceMemberApplicationDto> {
    const dm = await this.dms.createInterviewDm(app.workspaceId, actorId, app.applicantId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.workspaceMemberApplication.update({
        where: { id: app.id },
        data: {
          status: ApplicationStatus.INTERVIEW,
          reviewedById: actorId,
          interviewChannelId: dm.channelId,
        },
      });
      await this.recordReviewed(tx, row);
      return row;
    });
    return this.toDto(updated);
  }

  /** FR-W06: 신청 취소(PENDING → WITHDRAWN). 본인만, PENDING 외 상태는 409. */
  async withdraw(args: {
    workspaceId: string;
    applicationId: string;
    userId: string;
  }): Promise<WorkspaceMemberApplicationDto> {
    const { workspaceId, applicationId, userId } = args;
    const app = await this.prisma.workspaceMemberApplication.findFirst({
      where: { id: applicationId, workspaceId, applicantId: userId },
    });
    if (!app) {
      throw new DomainError(ErrorCode.APPLICATION_NOT_FOUND, 'application not found');
    }
    if (app.status !== ApplicationStatus.PENDING) {
      throw new DomainError(
        ErrorCode.APPLICATION_INVALID_STATE,
        'only a pending application can be withdrawn',
      );
    }
    const updated = await this.prisma.workspaceMemberApplication.update({
      where: { id: app.id },
      data: { status: ApplicationStatus.WITHDRAWN },
    });
    return this.toDto(updated);
  }

  /**
   * 신청 처리 결과를 application.reviewed outbox 로 기록(신청자 user 룸 fanout). update 결과
   * row 에는 applicantId/status/reviewNote/interviewChannelId 가 모두 있으므로 그대로 싣는다.
   */
  private async recordReviewed(
    tx: Prisma.TransactionClient,
    row: {
      id: string;
      workspaceId: string;
      applicantId: string;
      status: ApplicationStatus;
      reviewNote: string | null;
      interviewChannelId: string | null;
    },
  ): Promise<void> {
    const wire = WIRE_STATUS[row.status];
    if (!wire) return; // PENDING/WITHDRAWN 은 reviewed 이벤트 비대상.
    await this.outbox.record(tx as unknown as Parameters<OutboxService['record']>[0], {
      aggregateType: 'application',
      aggregateId: row.id,
      eventType: MEMBER_APPLICATION_REVIEWED,
      payload: {
        workspaceId: row.workspaceId,
        applicationId: row.id,
        applicantId: row.applicantId,
        status: wire,
        reviewNote: row.reviewNote,
        interviewChannelId: row.interviewChannelId,
      },
    });
  }

  private toDto(row: ApplicationRow): WorkspaceMemberApplicationDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      applicantId: row.applicantId,
      status: row.status,
      answers: parseAnswers(row.answers),
      reviewedById: row.reviewedById,
      reviewNote: row.reviewNote,
      interviewChannelId: row.interviewChannelId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      applicant: row.applicant ?? null,
    };
  }
}

/** answers JSON 을 [{questionId, answer}] 배열로 안전 파싱(형식 불량은 빈 배열). */
function parseAnswers(raw: Prisma.JsonValue): ApplicationAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: ApplicationAnswer[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).questionId === 'string' &&
      typeof (item as Record<string, unknown>).answer === 'string'
    ) {
      out.push({
        questionId: (item as Record<string, string>).questionId,
        answer: (item as Record<string, string>).answer,
      });
    }
  }
  return out;
}

/** reviewNote 정규화 — trim 후 빈 문자열이면 null. */
function normalizeNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}
