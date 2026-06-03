import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ReportQueueFilterSchema,
  ResolveReportRequestSchema,
  type ListReportsResponse,
} from '@qufox/shared-types';
import { ModerationReportService } from './moderation-report.service';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S64 (D12 / FR-RM11): 신고 큐 열람/처리 REST(워크스페이스 스코프).
 *
 * WorkspaceMemberGuard 로 멤버임만 확인하고, MODERATOR 이상 enum 게이트는
 * ModerationReportService 가 집행한다(처리 액션의 권한 비트/계층 방어는 재사용하는
 * ModerationService 가 추가로 enforce). 신고 *생성*은 별도로 MessagesController 에 둔다
 * (채널 ACL 가드가 필요).
 */
@UseGuards(WorkspaceMemberGuard)
@Controller('workspaces/:id/moderation/reports')
export class ModerationReportController {
  constructor(
    private readonly reports: ModerationReportService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** FR-RM11: 신고 큐 열람. filter=OPEN(미처리) / ALL. MODERATOR 이상. */
  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Query('filter') filterRaw: string | undefined,
  ): Promise<ListReportsResponse> {
    const parsed = ReportQueueFilterSchema.safeParse(filterRaw ?? 'OPEN');
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.reports.listReports({
      workspaceId: member.workspaceId,
      actorRole: member.role,
      filter: parsed.data,
    });
  }

  /** FR-RM11: 신고 처리(DISMISS/WARN/DELETE_MESSAGE/TIMEOUT/BAN). MODERATOR 이상. */
  @Post(':reportId/resolve')
  @HttpCode(204)
  async resolve(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ): Promise<void> {
    await this.rateLimit.enforce([
      { key: `report:resolve:ws:${member.workspaceId}`, windowSec: 60, max: 60 },
    ]);
    const parsed = ResolveReportRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.reports.resolveReport({
      workspaceId: member.workspaceId,
      reportId,
      actorId: member.userId,
      actorRole: member.role,
      action: parsed.data.action,
      reason: parsed.data.reason,
      durationSeconds: parsed.data.durationSeconds,
    });
  }
}
