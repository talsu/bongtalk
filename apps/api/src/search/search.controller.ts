import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { SearchService } from './search.service';

/**
 * Task-015-B: GET /search. Flat top-level path (no workspace prefix)
 * because `workspaceId` comes in as a query param — same rationale as
 * /messages/:id/reactions vs /workspaces/:wsid/.../reactions. The
 * service enforces workspace-scoped visibility via
 * ChannelAccessService, so no URL-level guard is needed.
 *
 * Rate limit: 30 req/min per user. With the 300ms debounce on the
 * frontend, a fast typist stays well under; the cap is for scripted
 * abuse, not real interactive use.
 */
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async run(
    @CurrentUser() user: CurrentUserPayload,
    @Query('q') q: string | undefined,
    @Query('workspaceId') workspaceId: string | undefined,
    @Query('channelId') channelId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limitRaw: string | undefined,
  ) {
    await this.rate.enforce([{ key: `search:u:${user.id}`, windowSec: 60, max: 30 }]);
    if (typeof q !== 'string' || q.trim().length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'q is required');
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'workspaceId is required');
    }
    const limit = clampLimit(limitRaw);
    return this.search.search({
      query: q,
      workspaceId,
      userId: user.id,
      channelId: channelId || undefined,
      cursor: cursor || undefined,
      limit,
    });
  }
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 20;
  if (n > 50) return 50;
  return Math.floor(n);
}
