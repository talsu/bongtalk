import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  SaveStatusSchema,
  type SavedCountResponse,
  type SavedMessageListResponse,
  type SaveToggleResponse,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { SavedService } from './saved.service';

/**
 * S51 (D10 / FR-PS-07): 개인 저장함 엔드포인트(`/me/saved`). JWT 인증만 거치는
 * 개인 전용 라우트다(워크스페이스/채널 가드 없음 — 가시성은 SavedService 가
 * READ ACL SQL 로 직접 검사한다).
 *
 * 라우트 순서: 고정 경로 `count` 를 `:messageId` 보다 먼저 선언해 'count' 가
 * UUID 로 오인되지 않게 한다(MessagesController.pins/count 와 동일 패턴).
 */
@UseGuards(JwtAuthGuard)
@Controller('me/saved')
export class SavedController {
  constructor(
    private readonly saved: SavedService,
    private readonly rate: RateLimitService,
  ) {}

  /**
   * GET /me/saved?status=IN_PROGRESS&limit=50&before=<cursor> — 커서 기반 목록.
   */
  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('status') statusRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('before') before: string | undefined,
  ): Promise<SavedMessageListResponse> {
    const parsedStatus = SaveStatusSchema.safeParse(statusRaw ?? 'IN_PROGRESS');
    if (!parsedStatus.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid saved status filter');
    }
    const limit = limitRaw !== undefined ? Number(limitRaw) : 50;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid limit');
    }
    return this.saved.list({
      userId: user.id,
      status: parsedStatus.data,
      limit,
      before: before && before.length > 0 ? before : undefined,
    });
  }

  /**
   * GET /me/saved/count — IN_PROGRESS 카운트(사이드바 "저장됨" 배지).
   */
  @Get('count')
  async count(@CurrentUser() user: CurrentUserPayload): Promise<SavedCountResponse> {
    const count = await this.saved.countInProgress(user.id);
    return { count };
  }

  /**
   * POST /me/saved/:messageId — 메시지를 개인 저장함에 저장(idempotent).
   * 500개 초과 시 422 SAVED_LIMIT_EXCEEDED, 접근 불가 채널 메시지면 404.
   */
  @Post(':messageId')
  @HttpCode(200)
  async save(
    @CurrentUser() user: CurrentUserPayload,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<SaveToggleResponse> {
    await this.rate.enforce([{ key: `saved:write:u:${user.id}`, windowSec: 60, max: 300 }]);
    return this.saved.save(user.id, messageId);
  }

  /**
   * DELETE /me/saved/:messageId — 저장 해제(idempotent). 본인 항목만 영향.
   */
  @Delete(':messageId')
  @HttpCode(200)
  async unsave(
    @CurrentUser() user: CurrentUserPayload,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<SaveToggleResponse> {
    await this.rate.enforce([{ key: `saved:write:u:${user.id}`, windowSec: 60, max: 300 }]);
    return this.saved.unsave(user.id, messageId);
  }
}
