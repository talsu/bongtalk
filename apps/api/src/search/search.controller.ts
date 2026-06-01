import { Controller, Delete, Get, HttpCode, Query, UseGuards } from '@nestjs/common';
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

  /**
   * S30 (FR-S07): GET /search/recent — 서버측 최근 검색어 목록.
   * Redis `search:recent:{userId}` LIST 를 newest-first 로 돌려준다.
   */
  @Get('recent')
  async recent(@CurrentUser() user: CurrentUserPayload): Promise<{ recents: string[] }> {
    await this.rate.enforce([{ key: `srecent:u:${user.id}`, windowSec: 60, max: 60 }]);
    const recents = await this.search.recentSearches(user.id);
    return { recents };
  }

  /**
   * S31 (FR-S11): DELETE /search/recent — 최근 검색어 삭제.
   *   - `?q=<entry>` 가 있으면 해당 엔트리 1건만 제거(LREM).
   *   - `q` 가 없으면 전체 삭제(DEL).
   *
   * 엔트리는 공백/슬래시 등 URL-unsafe 문자를 포함할 수 있으므로 path param
   * 대신 query string `q` 로 받습니다(라우팅 충돌 회피). userId 는
   * @CurrentUser 로 고정해 사용자 자신의 키에만 작용합니다(IDOR 차단).
   * 동일 rate-limit 버킷(srecent)을 공유합니다.
   */
  @Delete('recent')
  @HttpCode(204)
  async deleteRecent(
    @CurrentUser() user: CurrentUserPayload,
    @Query('q') q: string | undefined,
  ): Promise<void> {
    await this.rate.enforce([{ key: `srecent:u:${user.id}`, windowSec: 60, max: 60 }]);
    // S31 (security DoS): `q` 길이 상한. 거대 q 는 Redis LREM 이 리스트 전체를
    // 항목별 비교(O(N·M))로 훑게 만들어 남용 가능하므로 경계에서 차단한다.
    // 저장되는 최근 검색어는 RECENT_SEARCH_VALUE_MAX(200)를 넘지 못하므로,
    // 그보다 긴 q 는 매칭될 항목이 애초에 없다 → 거부한다(400 대신 무의미한
    // 요청이라 VALIDATION_FAILED 로 차단). q 가 비면 전체 삭제(DEL)로 분기.
    if (typeof q === 'string' && q.length > 0) {
      if (q.length > RECENT_SEARCH_VALUE_MAX) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          `q must be at most ${RECENT_SEARCH_VALUE_MAX} characters`,
        );
      }
      await this.search.removeRecentSearch(user.id, q);
    } else {
      await this.search.clearRecentSearches(user.id);
    }
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
    // S30 (FR-S06/S10): withContext=true 면 결과에 전/후 컨텍스트 + 스레드
    // 루트 excerpt 를 붙인다(권한 재검증 포함). 미지정/false 면 S29 응답 그대로.
    // 마지막 위치 + default 라 기존 호출부(11-arg)와 호환된다.
    @Query('withContext') withContextRaw: string | undefined = undefined,
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
    const params = {
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
    };
    // S30 (FR-S07): 결과를 돌려준 쿼리는 최근 검색으로 기록(원문 q — 수식어
    // 포함). 빈/공백 q 는 위 가드에서 이미 거른다. 기록 실패는 검색을 막지
    // 않는다(best-effort).
    void this.search.pushRecentSearch(user.id, q).catch(() => undefined);
    if (parseBoolParam(withContextRaw) === true) {
      return this.search.searchWithContext(params);
    }
    return this.search.search(params);
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

// S31 (security DoS): DELETE /search/recent 의 `q` 길이 상한. 저장 측
// (search.service.ts RECENT_SEARCH_VALUE_MAX)와 동일한 200 으로 맞춘다 —
// 저장 한도를 넘는 q 는 매칭될 엔트리가 없으므로 거부한다.
const RECENT_SEARCH_VALUE_MAX = 200;

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

// S31 (contract): suggest 기본 limit 을 web 송신값(SUGGEST_LIMIT=6)과 통일한다.
// 미지정/비정상 입력은 6 으로 degrade, 상한은 20 유지.
function clampSuggestLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 6;
  if (n > 20) return 20;
  return Math.floor(n);
}
