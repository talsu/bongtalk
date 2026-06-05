import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { GiphySearchRequestSchema, type GiphySearchResponse } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { ChannelAccessGuard } from '../channels/guards/channel-access.guard';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { GiphyProxyService } from './giphy-proxy.service';

/**
 * S81b (D15 / FR-SC-07) — GIPHY 검색 프록시 REST surface(프리뷰 Shuffle 용).
 *
 * POST /workspaces/:wsId/channels/:chid/giphy/search
 *   가드 체인: JwtAuthGuard(전역) → WorkspaceMemberGuard(:wsId, 비멤버 404) →
 *   ChannelAccessGuard(:chid). slash-execution 컨트롤러와 동일 스코프라 동일 가드를 재사용한다.
 *   rate 10/min/user(`giphy:search:u:{userId}`) — GIPHY beta 한도(100/hour)를 보호한다.
 *   API 키 미설정/GIPHY 오류는 GiphyProxyService 가 GIPHY_UNAVAILABLE(503) 로 graceful 거부.
 *   결과 0건은 200 + null GIF 가 아니라 GIPHY_UNAVAILABLE 이 아닌 "결과 없음"을 의미하므로,
 *   Shuffle 경로에서는 같은 키워드의 다음 GIF 가 없다는 것이라 404(NOT_FOUND)로 돌려준다.
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:wsId/channels/:chid/giphy')
export class GiphyController {
  constructor(
    private readonly giphy: GiphyProxyService,
    private readonly rate: RateLimitService,
  ) {}

  @Post('search')
  async search(
    @Param('wsId', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) _chid: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<GiphySearchResponse> {
    const parsed = GiphySearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // security MED-1 (S81b 리뷰): 미인증 계정은 슬래시 실행(execute) 게이트와 동일하게
    // GIPHY 검색(프리뷰 Shuffle)도 차단한다(S81a 패턴 동일 — EMAIL_NOT_VERIFIED 403).
    if (!user.emailVerified) {
      throw new DomainError(ErrorCode.EMAIL_NOT_VERIFIED, '이메일 인증 후 사용할 수 있습니다');
    }
    await this.rate.enforce([{ key: `giphy:search:u:${user.id}`, windowSec: 60, max: 10 }]);

    const result = await this.giphy.search(parsed.data.keyword, parsed.data.offset ?? 0);
    if (result === null) {
      // 같은 키워드의 (다음) GIF 가 없음 → 404. Shuffle 이 끝까지 돌면 FE 가 안내한다.
      throw new DomainError(ErrorCode.NOT_FOUND, '더 이상 표시할 GIF 가 없습니다');
    }
    return result;
  }
}
