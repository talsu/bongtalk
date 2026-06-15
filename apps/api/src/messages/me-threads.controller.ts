import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ListMyThreadsResponseSchema,
  SetThreadNotificationLevelRequestSchema,
  type ListMyThreadsResponse,
  type SetThreadNotificationLevelResponse,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { ThreadSubscriptionsService } from './thread-subscriptions.service';
import { MyThreadsService } from './my-threads.service';

/**
 * S38 (D04 / FR-TH-08/09/10) — 사용자 스코프 스레드 엔드포인트.
 *
 *   GET   /users/me/threads                              — FR-TH-09 내 구독 스레드 목록
 *   POST  /users/me/threads/read-all                     — FR-TH-10 전체 읽음 처리
 *   PATCH /users/me/threads/:parentMessageId/subscription — FR-TH-08 알림 레벨(수동 구독)
 *
 * JwtAuthGuard 만 — 워크스페이스/채널 스코프가 없는 cross-workspace 뷰라
 * me-dm-privacy.controller 와 동일하게 user 스코프 라우트로 둔다. 채널 READ
 * ACL 은 목록 쿼리(MyThreadsService)와 알림 레벨 설정(ThreadSubscriptionsService)이
 * 각자 enforce 한다(IDOR 차단).
 */
@UseGuards(JwtAuthGuard)
@Controller('users/me/threads')
export class MeThreadsController {
  constructor(
    private readonly myThreads: MyThreadsService,
    private readonly subscriptions: ThreadSubscriptionsService,
    private readonly rate: RateLimitService,
  ) {}

  /** FR-TH-09: 내 구독 스레드 목록(읽지 않음 우선, latestReplyAt DESC). */
  @Get()
  async list(@CurrentUser() user: CurrentUserPayload): Promise<ListMyThreadsResponse> {
    await this.rate.enforce([{ key: `threads:list:u:${user.id}`, windowSec: 60, max: 300 }]);
    const threads = await this.myThreads.listMine(user.id);
    // shared zod 로 응답 형태를 한 번 검증(계약 회귀 방지 — 채널/검색 응답 패턴 일관).
    return ListMyThreadsResponseSchema.parse({ threads });
  }

  /** FR-TH-10: 내 구독 스레드 전체를 각 최신 답글까지 읽음 처리(bulk upsert). */
  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: CurrentUserPayload): Promise<{ updated: number }> {
    await this.rate.enforce([{ key: `threads:read-all:u:${user.id}`, windowSec: 60, max: 60 }]);
    return this.myThreads.markAllRead(user.id);
  }

  /**
   * FR-TH-08: 스레드 알림 레벨 설정(+ 수동 구독). 루트 채널 READ ACL 은
   * ThreadSubscriptionsService.setNotificationLevel 이 강제한다(IDOR 차단).
   */
  @Patch(':parentMessageId/subscription')
  @HttpCode(200)
  async setNotificationLevel(
    @CurrentUser() user: CurrentUserPayload,
    @Param('parentMessageId', new ParseUUIDPipe()) parentMessageId: string,
    @Body() body: unknown,
  ): Promise<SetThreadNotificationLevelResponse> {
    await this.rate.enforce([{ key: `threads:sub:u:${user.id}`, windowSec: 60, max: 120 }]);
    const parsed = SetThreadNotificationLevelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const r = await this.subscriptions.setNotificationLevel({
      userId: user.id,
      threadParentId: parentMessageId,
      notificationLevel: parsed.data.notificationLevel,
    });
    return { notificationLevel: r.notificationLevel };
  }
}
