import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { SlashCommandListResponse } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { SlashCommandService } from './slash-command.service';

/**
 * S79 (D15 / FR-SC-01·02) — 슬래시 커맨드 목록 REST surface.
 *
 * GET /workspaces/:workspaceId/slash-commands
 *   - WorkspaceMemberGuard: 비멤버는 가드가 404/WORKSPACE_NOT_MEMBER 로 막는다(IDOR
 *     방어 — 가드가 403 대신 404 로 응답). 멤버면 누구나(@Roles 없음 — PRD: 모든 멤버).
 *   - rate 60/min per (workspace, user): 자동완성이 React Query staleTime 5분으로
 *     캐시하므로 핫패스가 아니지만, 캐시 우회/연타에 보수적 상한을 둔다.
 *   - 응답: 빌트인 상수 + DB 커스텀 병합({ items }). `/giphy` 는 GIPHY_API_KEY env
 *     게이트(서비스가 적용).
 *
 * ★ 실행 엔드포인트(POST execute)는 S80 — 본 컨트롤러는 GET 목록만 노출한다.
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
@Controller('workspaces/:wsId/slash-commands')
export class SlashCommandController {
  constructor(
    private readonly svc: SlashCommandService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async list(
    @Param('wsId', new ParseUUIDPipe()) wsId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SlashCommandListResponse> {
    await this.rateLimit.enforce([
      { key: `slash:list:${wsId}:${user.id}`, windowSec: 60, max: 60 },
    ]);
    return { items: await this.svc.list(wsId) };
  }
}
