import { Controller, Delete, Get, HttpCode, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionListResponse } from '@qufox/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { TokenService } from '../auth/services/token.service';
import { SessionsService } from './sessions.service';

const REFRESH_COOKIE = 'refresh_token';

/**
 * S77b (D14 / FR-PS-15): 세션 관리.
 *
 *   GET    /me/sessions      → {sessions: SessionSummary[]} (isCurrent 매핑)
 *   DELETE /me/sessions/:id  → 개별 세션 로그아웃(본인 소유 검증 · 없으면 SESSION_NOT_FOUND)
 *   DELETE /me/sessions      → 현재 세션 제외 전체 로그아웃
 *
 * rate-limit: GET 20/min · DELETE 10/min.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly rate: RateLimitService,
  ) {}

  private async currentFamilyId(req: Request): Promise<string | null> {
    const raw = (req.cookies ?? {})[REFRESH_COOKIE];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return this.tokens.familyIdForRaw(raw);
  }

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<SessionListResponse> {
    await this.rate.enforce([{ key: `sessions-get:u:${user.id}`, windowSec: 60, max: 20 }]);
    const familyId = await this.currentFamilyId(req);
    const sessions = await this.sessions.listSessions(user.id, familyId);
    return { sessions };
  }

  @Delete(':id')
  @HttpCode(204)
  async revokeOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<void> {
    await this.rate.enforce([{ key: `sessions-delete:u:${user.id}`, windowSec: 60, max: 10 }]);
    await this.sessions.revokeSession(user.id, id);
  }

  @Delete()
  @HttpCode(204)
  async revokeAll(
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<void> {
    await this.rate.enforce([{ key: `sessions-delete:u:${user.id}`, windowSec: 60, max: 10 }]);
    const familyId = await this.currentFamilyId(req);
    await this.sessions.revokeAllExceptCurrent(user.id, familyId);
  }
}
