import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateReminderRequestSchema,
  type ReminderItem,
  type ReminderListResponse,
} from '@qufox/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { ReminderService } from './reminder.service';

/**
 * S80 (D15 / FR-SC-06) — /remind 리마인더 REST surface(`/users/me/reminders`).
 *
 * JWT 인증만 거치는 개인 전용 라우트다(리마인더는 본인 전용 — 워크스페이스/채널 가드 없음).
 *   GET    — 본인 리마인더 목록(scheduledAt ASC).
 *   POST   — 자연어 시각 + 메시지로 리마인더 생성(execute 의 /remind 와 동일 로직 재사용).
 *   DELETE — 본인 리마인더 취소(BullMQ 잡 제거 + status=CANCELLED).
 */
@UseGuards(JwtAuthGuard)
@Controller('users/me/reminders')
export class ReminderController {
  constructor(
    private readonly reminders: ReminderService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload): Promise<ReminderListResponse> {
    await this.rate.enforce([{ key: `reminders:list:u:${user.id}`, windowSec: 60, max: 120 }]);
    return { items: await this.reminders.list(user.id) };
  }

  @Post()
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<ReminderItem> {
    const parsed = CreateReminderRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // S80 security BLOCKER fix: execute 경로(slash-execution.controller)와 동일하게 미인증
    // 계정의 리마인더 생성을 차단한다(S66 FR-W05a). 직접 REST 진입도 동일 게이트 적용 —
    // 미인증 계정이 BullMQ 지연잡을 적재(부팅 복구 DoS 면)하지 못하게 한다.
    if (!user.emailVerified) {
      throw new DomainError(ErrorCode.EMAIL_NOT_VERIFIED, '이메일 인증 후 사용할 수 있습니다');
    }
    await this.rate.enforce([{ key: `reminders:create:u:${user.id}`, windowSec: 60, max: 30 }]);
    return this.reminders.createFromNaturalLanguage({
      userId: user.id,
      channelId: parsed.data.channelId ?? null,
      when: parsed.data.when,
      message: parsed.data.message,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.rate.enforce([{ key: `reminders:delete:u:${user.id}`, windowSec: 60, max: 60 }]);
    await this.reminders.cancel(user.id, id);
  }
}
