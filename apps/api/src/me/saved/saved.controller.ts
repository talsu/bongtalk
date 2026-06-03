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
  UpdateSavedMessageBodySchema,
  SnoozeReminderBodySchema,
  WS_EVENTS,
  type SavedCountResponse,
  type SavedMessageDto,
  type SavedMessageListResponse,
  type SavedStatusBulkResponse,
  type SaveToggleResponse,
  type SavedUpdatedPayload,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
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
    // S53 (FR-PS-09/10/11): PATCH/snooze 성공 후 개인 user 룸으로 user:saved_updated
    // emit(다른 기기/탭 동기화). MeModule 이 RealtimeModule 을 이미 import 한다.
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * GET /me/saved?status=IN_PROGRESS&limit=50&before=<cursor> — 커서 기반 목록.
   * S53 (FR-PS-11): `?overdueReminder=true` 면 status 탭을 무시하고 놓친 리마인더
   * (reminderAt < now AND reminderFiredAt IS NOT NULL AND status != COMPLETED)만
   * 반환한다(재접속 시 배너/표시용).
   */
  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('status') statusRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('before') before: string | undefined,
    @Query('overdueReminder') overdueRaw: string | undefined,
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
      overdueReminder: overdueRaw === 'true',
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
    // S52 리뷰(security FINDING-1 · perf): read-tier rate-limit. 채널 진입당 1회
    // (신규 id 만) 호출되는 read-shaped 경로지만, 유일한 방어선이므로(글로벌 Throttler
    // 부재) 윈도를 둔다. write(300/60s)보다 여유 있게 120/60s.
    await this.rate.enforce([{ key: `saved:read:u:${user.id}`, windowSec: 60, max: 120 }]);
    const saved = await this.saved.statusBulk(user.id, parsed.data.messageIds);
    return { saved };
  }

  /**
   * S53 (FR-PS-10): PATCH /me/saved/:savedMessageId/snooze — "10분 후 다시 알림".
   * 정적 세그먼트(snooze)가 있어 `:savedMessageId`(PATCH) 보다 먼저 선언한다.
   * body `{ snoozeMinutes: 10 }`. 본인 항목이 아니면 404. 성공 후 user:saved_updated emit.
   */
  @Patch(':savedMessageId/snooze')
  @HttpCode(200)
  async snooze(
    @CurrentUser() user: CurrentUserPayload,
    @Param('savedMessageId', new ParseUUIDPipe()) savedMessageId: string,
    @Body() body: unknown,
  ): Promise<SavedMessageDto> {
    const parsed = SnoozeReminderBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid snooze request');
    }
    await this.rate.enforce([{ key: `saved:write:u:${user.id}`, windowSec: 60, max: 300 }]);
    const dto = await this.saved.snooze(user.id, savedMessageId, parsed.data.snoozeMinutes);
    this.emitSavedUpdated(user.id, dto);
    return dto;
  }

  /**
   * S52 (FR-PS-08) + S53 (FR-PS-09/10/11): PATCH /me/saved/:savedMessageId —
   * 저장 항목 갱신. status(탭 이동) / reminderAt(설정·취소) / note 를 함께(전부 optional)
   * 받는다. S52 의 status-only 호출은 그대로 동작한다(무회귀). 본인 항목이 아니거나
   * 없으면 404 SAVED_NOT_FOUND, body 가 스키마 외면 400. 성공 후 user:saved_updated emit.
   * ★경로 파라미터는 SavedMessage.id 다(POST/DELETE 의 :messageId 와 의도된 비대칭).
   */
  @Patch(':savedMessageId')
  @HttpCode(200)
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('savedMessageId', new ParseUUIDPipe()) savedMessageId: string,
    @Body() body: unknown,
  ): Promise<SavedMessageDto> {
    const parsed = UpdateSavedMessageBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid saved update');
    }
    await this.rate.enforce([{ key: `saved:write:u:${user.id}`, windowSec: 60, max: 300 }]);
    // reminderAt 은 string(ISO) | null | undefined 로 들어온다 — Date | null | undefined
    // 로 정규화해 서비스에 넘긴다.
    const reminderAt =
      parsed.data.reminderAt === undefined
        ? undefined
        : parsed.data.reminderAt === null
          ? null
          : new Date(parsed.data.reminderAt);
    const dto = await this.saved.update(user.id, savedMessageId, {
      status: parsed.data.status,
      reminderAt,
      note: parsed.data.note,
    });
    this.emitSavedUpdated(user.id, dto);
    return dto;
  }

  /**
   * S53 (FR-PS-09/10/11): 개인 user 룸으로 user:saved_updated 를 emit 한다(다른
   * 기기/탭 동기화). best-effort — emit 은 동기 호출이지만 게이트웨이 미준비/오프라인
   * 이면 no-op 이다.
   */
  private emitSavedUpdated(userId: string, dto: SavedMessageDto): void {
    const payload: SavedUpdatedPayload = {
      savedMessageId: dto.id,
      status: dto.status,
      reminderAt: dto.reminderAt ?? null,
    };
    this.gateway.emitToUserRoom(userId, WS_EVENTS.SAVED_UPDATED, payload);
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
