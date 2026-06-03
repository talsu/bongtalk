import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import {
  ROLE_RANK,
  type ListReportsResponse,
  type ModerationReport,
  type ReportAction,
  type ReportCategory,
  type ReportQueueFilter,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { MessagesService } from '../../messages/messages.service';
import { ModerationService } from './moderation.service';

/**
 * S64 (D12 / FR-RM11): 메시지 신고 큐 도메인 서비스.
 *
 * - reportMessage: 모든 멤버가 메시지를 카테고리별로 신고한다(@@unique 중복 방지 → 409).
 * - listReports: ADMIN/MODERATOR 가 큐를 열람한다(미처리 우선·최신순).
 * - resolveReport: ADMIN/MODERATOR 가 신고를 처리한다(DISMISS/WARN/DELETE_MESSAGE/
 *   TIMEOUT/BAN). DELETE_MESSAGE 는 MessagesService.softDelete, TIMEOUT/BAN 은
 *   ModerationService 를 재사용한다. 처리 결과는 resolved* 기록 + REPORT_RESOLVE 감사.
 *
 * 큐 열람/처리 권한 게이트는 ADMIN+ enum 계층(MODERATOR 이상)으로 본다 — PRD FR-RM11
 * "ADMIN/MODERATOR 가 큐 열람/처리". 신고 생성은 모든 멤버(컨트롤러가 멤버십만 확인).
 */
@Injectable()
export class ModerationReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moderation: ModerationService,
    // DELETE_MESSAGE 처리에 messages.softDelete 재사용. WorkspacesModule ↔ MessagesModule
    // 순환을 forwardRef 로 끊는다(MessagesModule 이 WorkspacesModule 을 import).
    @Inject(forwardRef(() => MessagesService))
    private readonly messages: MessagesService,
  ) {}

  /**
   * FR-RM11: 메시지 신고 생성. 신고자/메시지/채널 컨텍스트는 컨트롤러가 채널 ACL 가드로
   * 검증한 상태로 넘긴다. (messageId, reporterId) 중복은 409 REPORT_DUPLICATE.
   */
  async reportMessage(args: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    reporterId: string;
    category: ReportCategory;
    reason?: string;
  }): Promise<void> {
    const reason = normalizeReason(args.reason);
    // 메시지가 해당 채널에 존재하는지 확인(삭제 메시지도 신고 가능 — 모더레이션 컨텍스트).
    const message = await this.prisma.message.findFirst({
      where: { id: args.messageId, channelId: args.channelId },
      select: { id: true },
    });
    if (!message) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found in channel');
    }
    try {
      await this.prisma.moderationReport.create({
        data: {
          workspaceId: args.workspaceId,
          channelId: args.channelId,
          messageId: args.messageId,
          reporterId: args.reporterId,
          category: args.category,
          reason,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.REPORT_DUPLICATE, 'you have already reported this message');
      }
      throw e;
    }
  }

  /**
   * FR-RM11: 신고 큐 열람. ADMIN/MODERATOR 만. filter=OPEN(미처리만) / ALL(전체).
   * 미처리 우선 → 최신순. 메시지/신고자 표시 정보를 batch 조회로 채운다(N+1 회피).
   */
  async listReports(args: {
    workspaceId: string;
    actorRole: WorkspaceRole;
    filter: ReportQueueFilter;
  }): Promise<ListReportsResponse> {
    this.assertModerator(args.actorRole);
    const where: Prisma.ModerationReportWhereInput = { workspaceId: args.workspaceId };
    if (args.filter === 'OPEN') where.resolvedAt = null;
    const rows = await this.prisma.moderationReport.findMany({
      where,
      // 미처리(resolvedAt NULL) 먼저, 그다음 최신순.
      orderBy: [{ resolvedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: 200,
    });
    const messageIds = Array.from(new Set(rows.map((r) => r.messageId)));
    const reporterIds = Array.from(new Set(rows.map((r) => r.reporterId)));
    const [messages, reporters] = await Promise.all([
      messageIds.length === 0
        ? Promise.resolve([])
        : this.prisma.message.findMany({
            where: { id: { in: messageIds } },
            select: { id: true, authorId: true, content: true, deletedAt: true },
          }),
      reporterIds.length === 0
        ? Promise.resolve([])
        : this.prisma.user.findMany({
            where: { id: { in: reporterIds } },
            select: { id: true, username: true },
          }),
    ]);
    const messageMap = new Map(messages.map((m) => [m.id, m]));
    const reporterMap = new Map(reporters.map((u) => [u.id, u]));
    const reports: ModerationReport[] = rows.map((r) => {
      const msg = messageMap.get(r.messageId);
      const deleted = msg?.deletedAt != null;
      return {
        id: r.id,
        workspaceId: r.workspaceId,
        messageId: r.messageId,
        channelId: r.channelId,
        reporterId: r.reporterId,
        category: r.category as ReportCategory,
        reason: r.reason ?? null,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy ?? null,
        resolvedAction: (r.resolvedAction as ReportAction | null) ?? null,
        message: msg
          ? { authorId: msg.authorId, content: deleted ? null : msg.content, deleted }
          : null,
        reporter: reporterMap.get(r.reporterId) ?? null,
      };
    });
    return { reports };
  }

  /**
   * FR-RM11: 신고 처리. ADMIN/MODERATOR 만. 이미 처리된 신고는 409. 액션별:
   *   - DISMISS: 기각(추가 액션 없음).
   *   - WARN: 경고(상태 기록만 — 별도 알림은 carryover).
   *   - DELETE_MESSAGE: messages.softDelete(워크스페이스 채널).
   *   - TIMEOUT: moderation.timeout(durationSeconds 필요 — 컨트롤러가 zod 검증).
   *   - BAN: moderation.ban(영구 차단).
   * 처리 후 resolved*(At/By/Action) 기록 + REPORT_RESOLVE 감사.
   */
  async resolveReport(args: {
    workspaceId: string;
    reportId: string;
    actorId: string;
    actorRole: WorkspaceRole;
    action: ReportAction;
    reason?: string;
    durationSeconds?: number;
  }): Promise<void> {
    this.assertModerator(args.actorRole);
    const reason = normalizeReason(args.reason);
    const report = await this.prisma.moderationReport.findFirst({
      where: { id: args.reportId, workspaceId: args.workspaceId },
    });
    if (!report) {
      throw new DomainError(ErrorCode.REPORT_NOT_FOUND, 'report not found');
    }
    if (report.resolvedAt) {
      throw new DomainError(ErrorCode.REPORT_ALREADY_RESOLVED, 'report is already resolved');
    }
    // 대상 메시지 작성자(TIMEOUT/BAN 대상 userId 해석용).
    const message = await this.prisma.message.findUnique({
      where: { id: report.messageId },
      select: { authorId: true, channelId: true },
    });

    // 부수 효과(메시지 삭제/타임아웃/차단)를 먼저 수행한다. 권한 비트/계층 방어는
    // ModerationService 가 내부에서 enforce 하므로(actorId 가 모더레이션 비트를 가져야 함),
    // MODERATOR enum 게이트만으로 부족한 경우 그쪽에서 403 이 던져진다.
    if (args.action === 'DELETE_MESSAGE' && message) {
      await this.messages.softDelete({
        workspaceId: args.workspaceId,
        channelId: message.channelId,
        msgId: report.messageId,
        actorId: args.actorId,
      });
    } else if (args.action === 'TIMEOUT' && message) {
      await this.moderation.timeout({
        workspaceId: args.workspaceId,
        actorId: args.actorId,
        targetUserId: message.authorId,
        durationSeconds: args.durationSeconds ?? 0,
        reason: reason ?? undefined,
      });
    } else if (args.action === 'BAN' && message) {
      await this.moderation.ban({
        workspaceId: args.workspaceId,
        actorId: args.actorId,
        targetUserId: message.authorId,
        reason: reason ?? undefined,
      });
    }

    // resolved* 기록 + REPORT_RESOLVE 감사(같은 tx — 원자성). updateMany WHERE resolvedAt
    // NULL 로 동시 처리 레이스를 닫는다(두 모더레이터 동시 처리 시 한쪽만 count=1).
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.moderationReport.updateMany({
        where: { id: report.id, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedBy: args.actorId,
          resolvedAction: args.action,
        },
      });
      if (count === 0) {
        throw new DomainError(ErrorCode.REPORT_ALREADY_RESOLVED, 'report is already resolved');
      }
      await this.audit.record(
        {
          workspaceId: args.workspaceId,
          actorId: args.actorId,
          action: AuditAction.REPORT_RESOLVE,
          targetId: report.messageId,
          channelId: report.channelId,
          details: {
            reportId: report.id,
            action: args.action,
            category: report.category,
            ...(reason ? { reason } : {}),
            ...(args.durationSeconds ? { durationSeconds: args.durationSeconds } : {}),
          },
        },
        tx,
      );
    });
  }

  /** FR-RM11: 신고 큐 열람/처리는 MODERATOR 이상 enum 계층. */
  private assertModerator(role: WorkspaceRole): void {
    if (ROLE_RANK[role] < ROLE_RANK[WorkspaceRole.MODERATOR]) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'requires MODERATOR or higher to view or resolve reports',
      );
    }
  }
}

/** 사유 정규화 — trim 후 빈 문자열이면 null(미제공 취급). */
function normalizeReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}
