import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { SearchService, type SearchSort } from './search.service';

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
    assertQLength(q);
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'workspaceId is required');
    }
    assertUuid(workspaceId, 'workspaceId');
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
    // S29 (FR-S08): 정렬 토글. relevance(기본) | recent.
    @Query('sort') sortRaw: string | undefined,
  ) {
    await this.rate.enforce([{ key: `search:u:${user.id}`, windowSec: 60, max: 30 }]);
    if (typeof q !== 'string' || q.trim().length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'q is required');
    }
    // S29 (security MEDIUM/DoS): q 길이 상한. 무제한이면 거대 ILIKE 풀스캔이
    // 가능하므로 컨트롤러 경계에서 차단한다.
    assertQLength(q);
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'workspaceId is required');
    }
    // S29 (security MEDIUM): UUID 형식 검증. 비-UUID 가 `::uuid` 캐스팅까지
    // 흘러가면 Prisma 가 DB 에러를 500 으로 누출한다. 경계에서 400 으로 차단.
    assertUuid(workspaceId, 'workspaceId');
    const channelIdParam = channelId || undefined;
    const senderIdParam = senderId || undefined;
    if (channelIdParam) assertUuid(channelIdParam, 'channelId');
    if (senderIdParam) assertUuid(senderIdParam, 'senderId');
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
      channelId: channelIdParam,
      senderId: senderIdParam,
      since: sinceDate,
      until: untilDate,
      hasAttachment: parseBoolParam(hasAttachmentRaw),
      sort: parseSortParam(sortRaw),
      cursor: cursor || undefined,
      limit,
    });
  }
}

// S29 (security MEDIUM): RFC 4122 UUID 형식. Prisma `::uuid` 캐스팅 전에
// 컨트롤러에서 검증해 비정상 입력이 DB 까지 흘러 500 으로 누출되는 것을 막는다.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, `${name} must be a valid UUID`);
  }
}

// S29 (security MEDIUM/DoS): q 길이 상한(modifier 토큰 포함 원문 기준).
const Q_MAX_LENGTH = 500;

function assertQLength(q: string): void {
  if (q.length > Q_MAX_LENGTH) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `q must be at most ${Q_MAX_LENGTH} characters`,
    );
  }
}

// S29 (FR-S08): sort 파라미터 — recent 명시일 때만 recent, 그 외(미지정·임의)
// 는 기본 relevance. 잘못된 값에 400 을 던지지 않고 기본값으로 degrade 한다.
function parseSortParam(raw: string | undefined): SearchSort {
  return raw === 'recent' ? 'recent' : 'relevance';
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
