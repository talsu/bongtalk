import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import {
  REPORT_QUEUE_PAGE_DEFAULT,
  REPORT_QUEUE_PAGE_MAX,
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
import { ChannelAccessService } from '../../channels/permission/channel-access.service';
import { Permission } from '../../auth/permissions';
import { ModerationService } from './moderation.service';

/**
 * S64 (D12 / FR-RM11): 메시지 신고 큐 도메인 서비스.
 *
 * - reportMessage: 모든 멤버가 메시지를 카테고리별로 신고한다(@@unique 중복 방지 → 409).
 * - listReports: ADMIN/MODERATOR 가 큐를 열람한다(미처리 우선·최신순·cursor 페이지네이션).
 *   private 채널 비멤버에게는 메시지 content 를 마스킹한다(security A-2).
 * - resolveReport: ADMIN/MODERATOR 가 신고를 처리한다(DISMISS/WARN/DELETE_MESSAGE/
 *   TIMEOUT/BAN). DELETE_MESSAGE 는 채널 DELETE_ANY_MESSAGE 권한 fold + position 계층
 *   (security A-1)을 강제하고, TIMEOUT/BAN 은 ModerationService 를 재사용한다. 부수효과는
 *   claim(updateMany 락) 성공 후에만 실행한다(security A-8 — 동시 처리 중복 방지).
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
    // S64 fix-forward (security A-1/A-2): DELETE_MESSAGE 채널 권한 fold + private 채널
    // content 마스킹에 채널 ACL 단일 출처를 재사용한다.
    private readonly channelAccess: ChannelAccessService,
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
   * 미처리 우선 → 최신순. cursor 페이지네이션(B-4) + 메시지/신고자 표시 정보 batch 조회.
   *
   * security A-2 (BLOCKER-2): private 채널 비멤버 모더레이터에게는 메시지 content 를
   * 마스킹한다(IDOR 방지). 각 신고의 채널에 actor 가 READ 권한을 갖는지 batch 로 판정해,
   * 권한 없는 채널의 content 는 null + contentMasked=true 로 내린다.
   */
  async listReports(args: {
    workspaceId: string;
    actorId: string;
    actorRole: WorkspaceRole;
    filter: ReportQueueFilter;
    cursor?: string;
    limit?: number;
  }): Promise<ListReportsResponse> {
    this.assertModerator(args.actorRole);
    const take = Math.min(args.limit ?? REPORT_QUEUE_PAGE_DEFAULT, REPORT_QUEUE_PAGE_MAX);
    const where: Prisma.ModerationReportWhereInput = { workspaceId: args.workspaceId };
    if (args.filter === 'OPEN') where.resolvedAt = null;
    // cursor 키셋: 정렬은 (resolvedAt ASC NULLS FIRST, createdAt DESC, id DESC) 라
    // 미처리(resolvedAt NULL) 먼저 → 처리됨(resolvedAt 오름차순) → 같은 resolvedAt 내
    // 최신순. cursor 이후 행만 남기는 OR 술어를 구성한다(NULLS FIRST 경계 포함).
    if (args.cursor) {
      Object.assign(where, decodeReportCursorWhere(args.cursor));
    }
    const rows = await this.prisma.moderationReport.findMany({
      where,
      // 미처리(resolvedAt NULL) 먼저, 그다음 처리 시각 오름차순, 같은 그룹 내 최신순.
      orderBy: [
        { resolvedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    const messageIds = Array.from(new Set(page.map((r) => r.messageId)));
    const reporterIds = Array.from(
      new Set(page.map((r) => r.reporterId).filter((id): id is string => id !== null)),
    );
    const channelIds = Array.from(new Set(page.map((r) => r.channelId)));
    const [messages, reporters, channels] = await Promise.all([
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
      channelIds.length === 0
        ? Promise.resolve([])
        : this.prisma.channel.findMany({
            where: { id: { in: channelIds } },
            select: { id: true, workspaceId: true, isPrivate: true },
          }),
    ]);
    const messageMap = new Map(messages.map((m) => [m.id, m]));
    const reporterMap = new Map(reporters.map((u) => [u.id, u]));

    // security A-2: 채널별로 actor 의 READ 접근권을 한 번씩 판정한다(채널 수만큼 — N+1
    // 아님). private 채널 비멤버면 마스킹, 공개 채널/멤버면 content 노출.
    const channelAccess = new Map<string, boolean>();
    await Promise.all(
      channels.map(async (c) => {
        if (!c.isPrivate) {
          channelAccess.set(c.id, true);
          return;
        }
        const canRead = await this.channelAccess.hasPermission(
          { id: c.id, workspaceId: c.workspaceId, isPrivate: c.isPrivate },
          args.actorId,
          Permission.READ,
        );
        channelAccess.set(c.id, canRead);
      }),
    );

    const reports: ModerationReport[] = page.map((r) => {
      const msg = messageMap.get(r.messageId);
      const deleted = msg?.deletedAt != null;
      const canSeeContent = channelAccess.get(r.channelId) ?? false;
      // 마스킹: private 채널 비접근. 삭제 메시지는 content 가 이미 null 이라 별개.
      const masked = msg != null && !deleted && !canSeeContent;
      const content = msg == null ? null : deleted || masked ? null : msg.content;
      return {
        id: r.id,
        workspaceId: r.workspaceId,
        messageId: r.messageId,
        channelId: r.channelId,
        reporterId: r.reporterId ?? null,
        category: r.category as ReportCategory,
        reason: r.reason ?? null,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy ?? null,
        resolvedAction: (r.resolvedAction as ReportAction | null) ?? null,
        message: msg ? { authorId: msg.authorId, content, deleted, contentMasked: masked } : null,
        reporter: (r.reporterId && reporterMap.get(r.reporterId)) || null,
      };
    });
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeReportCursor(last) : null;
    return { reports, nextCursor };
  }

  /**
   * FR-RM11: 신고 처리. ADMIN/MODERATOR 만. 이미 처리된 신고는 409. 액션별:
   *   - DISMISS: 기각(추가 액션 없음).
   *   - WARN: 경고(상태 기록만 — 별도 알림은 carryover).
   *   - DELETE_MESSAGE: 채널 DELETE_ANY_MESSAGE 권한 fold + position 계층(A-1) 후
   *     messages.softDelete(워크스페이스 채널, 감사 skip — REPORT_RESOLVE 가 대체).
   *   - TIMEOUT: moderation.timeout(durationSeconds 필요 — 컨트롤러가 zod 검증).
   *   - BAN: moderation.ban(영구 차단).
   *
   * security A-8 (= reviewer m-4): claim(updateMany WHERE resolvedAt NULL) 락을 *먼저*
   * 잡아 count===1 일 때만 부수효과를 실행한다 — 두 모더레이터 동시 처리 시 부수효과
   * (삭제/타임아웃/차단)·감사가 중복되지 않는다.
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
    // 대상 메시지 작성자(DELETE 계층/TIMEOUT/BAN 대상 userId 해석용).
    const message = await this.prisma.message.findUnique({
      where: { id: report.messageId },
      select: { authorId: true, channelId: true },
    });

    // security A-7 (MEDIUM-3): DELETE_MESSAGE 인데 메시지가 이미 없으면(하드삭제 등) 무음
    // 성공 대신 DISMISS 로 변환하고 audit details 에 skip 사유를 남긴다. (soft-delete 된
    // 메시지는 message!=null 이고 softDelete 가 멱등 no-op 이라 정상 DELETE 로 둔다.)
    let effectiveAction: ReportAction = args.action;
    let impliedSkip: { reason: string } | null = null;
    if (args.action === 'DELETE_MESSAGE' && !message) {
      effectiveAction = 'DISMISS';
      impliedSkip = { reason: 'message_not_found' };
    }

    // security A-1 (BLOCKER-1 = reviewer M-1): DELETE_MESSAGE 권한 계층. 채널
    // DELETE_ANY_MESSAGE 비트 fold + 메시지 작성자에 대한 position 계층을 *부수효과
    // 실행 전*에 강제한다(MODERATOR enum 게이트만으로는 ADMIN 메시지 삭제를 못 막는다).
    // assertModerator 통과 후에도 비트/계층이 부족하면 여기서 403 으로 거부한다.
    if (effectiveAction === 'DELETE_MESSAGE' && message) {
      const channel = await this.prisma.channel.findUnique({
        where: { id: message.channelId },
        select: { id: true, workspaceId: true, isPrivate: true },
      });
      if (!channel) {
        throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
      }
      const canDelete = await this.channelAccess.hasPermission(
        { id: channel.id, workspaceId: channel.workspaceId, isPrivate: channel.isPrivate },
        args.actorId,
        Permission.DELETE_ANY_MESSAGE,
      );
      if (!canDelete) {
        throw new DomainError(
          ErrorCode.FORBIDDEN,
          'MANAGE_MESSAGES permission is required to delete this message',
        );
      }
      // position 계층 — MODERATOR 가 ADMIN/OWNER 메시지를 삭제하는 권한 상승을 막는다.
      await this.moderation.assertActorOutranksAuthor(
        args.workspaceId,
        args.actorId,
        message.authorId,
      );
    }

    // security A-8 (= reviewer m-4): claim 을 *먼저* 잡는다. updateMany WHERE resolvedAt
    // NULL 가 count===1 을 반환했을 때만(이 actor 가 처리권을 획득) 부수효과를 실행한다.
    // 동시 처리 시 한쪽만 count===1 → 부수효과/감사 중복이 원천 차단된다.
    const resolvedAt = new Date();
    const { count } = await this.prisma.moderationReport.updateMany({
      where: { id: report.id, resolvedAt: null },
      data: {
        resolvedAt,
        resolvedBy: args.actorId,
        resolvedAction: effectiveAction,
      },
    });
    if (count === 0) {
      throw new DomainError(ErrorCode.REPORT_ALREADY_RESOLVED, 'report is already resolved');
    }

    // claim 획득 후 부수효과. 권한 비트/계층은 위에서 이미 검증했다.
    // perf B-2 (SERIOUS-2): DELETE_MESSAGE 는 auditMode='skip' 으로 softDelete 의 중복
    // MESSAGE_DELETE 감사/이중 tx 를 없앤다 — REPORT_RESOLVE details.impliedAction 이 대신.
    if (effectiveAction === 'DELETE_MESSAGE' && message) {
      await this.messages.softDelete({
        workspaceId: args.workspaceId,
        channelId: message.channelId,
        msgId: report.messageId,
        actorId: args.actorId,
        auditMode: 'skip',
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

    // REPORT_RESOLVE 감사(best-effort — claim 은 이미 확정됐고, 감사 실패가 처리 자체를
    // 되돌리면 안 된다). DELETE_MESSAGE 는 impliedAction 으로 MESSAGE_DELETE 를 대체한다.
    await this.audit.recordBestEffort({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      action: AuditAction.REPORT_RESOLVE,
      targetId: report.messageId,
      channelId: report.channelId,
      details: {
        reportId: report.id,
        action: effectiveAction,
        category: report.category,
        ...(effectiveAction === 'DELETE_MESSAGE' ? { impliedAction: 'MESSAGE_DELETE' } : {}),
        ...(impliedSkip ? { skipped: true, reason: impliedSkip.reason } : {}),
        ...(reason ? { reason } : {}),
        ...(args.durationSeconds ? { durationSeconds: args.durationSeconds } : {}),
      },
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

/**
 * S64 fix-forward (B-4 = MODERATE-4): 신고 큐 cursor 인코드/디코드. 정렬이
 * (resolvedAt ASC NULLS FIRST, createdAt DESC, id DESC) 라 키셋 경계를 3-튜플로 담는다.
 * resolvedAt 은 null(미처리) 가능 — null sentinel 로 직렬화한다. opaque base64url(JSON).
 */
type ReportCursorRow = { resolvedAt: Date | null; createdAt: Date; id: string };

function encodeReportCursor(row: ReportCursorRow): string {
  return Buffer.from(
    JSON.stringify({
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }),
    'utf8',
  ).toString('base64url');
}

const REPORT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * cursor 이후 행만 남기는 Prisma WHERE 절을 만든다. 정렬 키 (resolvedAt ASC NULLS FIRST,
 * createdAt DESC, id DESC) 의 strict-after 경계를 표현한다:
 *   - resolvedAt 그룹이 더 뒤(처리됨이 미처리보다 뒤, 또는 더 늦은 resolvedAt) OR
 *   - 같은 resolvedAt 그룹에서 (createdAt, id) 가 더 작음(DESC).
 * NULLS FIRST 라 cursor.resolvedAt===null(미처리)이면 다음 후보는 "같은 미처리 그룹 내
 * (createdAt,id) 더 작음" 또는 "처리됨 그룹 전체"다.
 */
function decodeReportCursorWhere(raw: string): Prisma.ModerationReportWhereInput {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'report cursor empty or too long');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'report cursor decode failed');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'report cursor not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const { resolvedAt, createdAt, id } = obj;
  if (typeof createdAt !== 'string' || !REPORT_ISO_RE.test(createdAt)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'report cursor.createdAt invalid');
  }
  if (typeof id !== 'string' || !REPORT_UUID_RE.test(id)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'report cursor.id must be a uuid');
  }
  if (resolvedAt !== null && (typeof resolvedAt !== 'string' || !REPORT_ISO_RE.test(resolvedAt))) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'report cursor.resolvedAt invalid');
  }
  const createdAtDate = new Date(createdAt);
  const sameGroupAfter = { createdAt: { lt: createdAtDate } as Prisma.DateTimeFilter };
  // 같은 그룹 내 createdAt 동률이면 id 더 작음(DESC tie-break) 도 포함한다.
  const sameGroupTie = { createdAt: createdAtDate, id: { lt: id } };
  if (resolvedAt === null) {
    // 미처리 그룹 cursor: 같은 미처리 그룹의 더 뒤 + 처리됨 그룹 전체(resolvedAt NOT NULL).
    return {
      OR: [
        { resolvedAt: null, ...sameGroupAfter },
        { resolvedAt: null, ...sameGroupTie },
        { resolvedAt: { not: null } },
      ],
    };
  }
  const resolvedAtDate = new Date(resolvedAt);
  // 처리됨 그룹 cursor: 더 늦게 처리된 그룹 + 같은 resolvedAt 그룹의 더 뒤(createdAt/id).
  return {
    OR: [
      { resolvedAt: { gt: resolvedAtDate } },
      { resolvedAt: resolvedAtDate, ...sameGroupAfter },
      { resolvedAt: resolvedAtDate, ...sameGroupTie },
    ],
  };
}
