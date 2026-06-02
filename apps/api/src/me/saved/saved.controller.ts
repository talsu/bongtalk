import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  SavedStatusBulkRequestSchema,
  SaveStatusSchema,
  UpdateSavedStatusBodySchema,
  type SavedCountResponse,
  type SavedMessageDto,
  type SavedMessageListResponse,
  type SavedStatusBulkResponse,
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
 * 라우트 순서: 고정 경로 `count` · `status-bulk` 를 파라미터 경로(`:messageId` ·
 * `:savedMessageId`) 보다 먼저 선언해 'count'/'status-bulk' 가 UUID 로 오인되지
 * 않게 한다(MessagesController.pins/count 와 동일 패턴). ParseUUIDPipe 가 비-UUID
 * 세그먼트를 400 으로 거르므로 정적 경로가 동사·세그먼트 모두에서 우선해야 한다.
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
   * S52 (FR-PS-13): POST /me/saved/status-bulk — 메시지 id 배치(≤200)에 대해 호출자가
   * 저장한(어느 status 든) messageId 집합을 반환한다. 채널 진입 시 북마크 채움 상태를
   * 1회 batch 로 seed 한다(N+1 단건 GET 금지). 정적 경로라 `:messageId`(POST) 보다
   * 먼저 선언한다.
   */
  @Post('status-bulk')
  @HttpCode(200)
  async statusBulk(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<SavedStatusBulkResponse> {
    const parsed = SavedStatusBulkRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid saved status-bulk request');
    }
    const saved = await this.saved.statusBulk(user.id, parsed.data.messageIds);
    return { saved };
  }

  /**
   * S52 (FR-PS-08): PATCH /me/saved/:savedMessageId — 저장 항목의 탭(status) 이동.
   * 본인 항목이 아니거나 없으면 404 SAVED_NOT_FOUND, status 가 enum 외면 400.
   * ★경로 파라미터는 SavedMessage.id 다(POST/DELETE 의 :messageId 와 의도된 비대칭).
   */
  @Patch(':savedMessageId')
  @HttpCode(200)
  async updateStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('savedMessageId', new ParseUUIDPipe()) savedMessageId: string,
    @Body() body: unknown,
  ): Promise<SavedMessageDto> {
    const parsed = UpdateSavedStatusBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid saved status');
    }
    await this.rate.enforce([{ key: `saved:write:u:${user.id}`, windowSec: 60, max: 300 }]);
    return this.saved.updateStatus(user.id, savedMessageId, parsed.data.status);
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
