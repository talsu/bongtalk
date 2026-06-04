import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ListAuditLogsQuerySchema, type ListAuditLogsResponse } from '@qufox/shared-types';
import { AuditService } from '../../common/audit/audit.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S64 (D12 / FR-RM12): 감사 로그 조회 REST.
 *
 * VIEW_AUDIT_LOG 권한은 별도 비트를 신설하지 않고(★결정 B) ADMIN+ enum 계층 게이트로
 * 본다 — @Roles('ADMIN') 이 OWNER/ADMIN 만 통과시킨다(WorkspaceRoleGuard 가
 * ROLE_RANK 비교). 무기한 보존·cursor 페이지네이션·action/actor 필터. append-only
 * (AuditService 가 read-only 조회만 노출).
 */
@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/audit-logs')
export class AuditLogController {
  constructor(
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** FR-RM12: 감사 로그 cursor 페이지 조회. ADMIN+ 만 허용. */
  @Roles('ADMIN')
  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ListAuditLogsResponse> {
    // 조회 폭주 방어(per-workspace). 읽기 전용이라 윈도는 다소 넉넉하게 둔다.
    await this.rateLimit.enforce([
      { key: `audit:list:ws:${member.workspaceId}`, windowSec: 60, max: 120 },
    ]);
    const parsed = ListAuditLogsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.audit.listAuditLogs({
      workspaceId: member.workspaceId,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
      action: parsed.data.action,
      actorId: parsed.data.actorId,
    });
  }
}
