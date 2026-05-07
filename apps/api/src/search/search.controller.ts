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

  /**
   * task-046 iter3 (J1): GET /search/suggest — typing-time suggestions.
   *
   * 워크스페이스 visible channel 이름 + 멤버 username prefix-match.
   * Rate: 60 req/min/user (debounce 200ms 가 표준 frontend 사용법).
   */
  @Get('suggest')
  async suggest(
    @CurrentUser() user: CurrentUserPayload,
    @Query('q') q: string | undefined,
    @Query('workspaceId') workspaceId: string | undefined,
    @Query('limit') limitRaw: string | undefined,
  ) {
    await this.rate.enforce([{ key: `suggest:u:${user.id}`, windowSec: 60, max: 60 }]);
    if (typeof q !== 'string' || q.trim().length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'q is required');
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'workspaceId is required');
    }
    const limit = clampSuggestLimit(limitRaw);
    return this.search.suggest({ workspaceId, userId: user.id, prefix: q, limit });
  }

  @Get()
  async run(
    @CurrentUser() user: CurrentUserPayload,
    @Query('q') q: string | undefined,
    @Query('workspaceId') workspaceId: string | undefined,
    @Query('channelId') channelId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    // task-046 iter3 (J3): filter params — sender / 기간 / has-attachment.
    @Query('senderId') senderId: string | undefined,
    @Query('since') since: string | undefined,
    @Query('until') until: string | undefined,
    @Query('hasAttachment') hasAttachmentRaw: string | undefined,
  ) {
    await this.rate.enforce([{ key: `search:u:${user.id}`, windowSec: 60, max: 30 }]);
    if (typeof q !== 'string' || q.trim().length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'q is required');
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'workspaceId is required');
    }
    const limit = clampLimit(limitRaw);
    const sinceDate = parseDateParam(since, 'since');
    const untilDate = parseDateParam(until, 'until');
    if (sinceDate && untilDate && sinceDate >= untilDate) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'since must be < until');
    }
    return this.search.search({
      query: q,
      workspaceId,
      userId: user.id,
      channelId: channelId || undefined,
      senderId: senderId || undefined,
      since: sinceDate,
      until: untilDate,
      hasAttachment: parseBoolParam(hasAttachmentRaw),
      cursor: cursor || undefined,
      limit,
    });
  }
}

function parseDateParam(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, `invalid ISO date for ${name}`);
  }
  return d;
}

function parseBoolParam(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 20;
  if (n > 50) return 50;
  return Math.floor(n);
}

function clampSuggestLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 5;
  if (n > 20) return 20;
  return Math.floor(n);
}
