import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { MutesService } from './mutes.service';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * task-045 iter3: channel/DM mute endpoints.
 *
 * 권한 모델: 사용자는 자기 자신의 mute 만 조작 가능 — channel access
 * 검증은 mute 행위 자체에 적용 안 함 (이미 access 가 없으면 채널 알림
 * 자체가 안 와서 mute 의미 없음 → 그냥 두면 됨).
 *
 * 향후 ChannelAccessGuard 가 필요하면 follow-up 으로 추가합니다.
 */
@Controller('me/mutes')
export class MutesController {
  constructor(private readonly mutes: MutesService) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload) {
    const items = await this.mutes.listActiveMutes(user.id);
    return {
      items: items.map((r) => ({
        channelId: r.channelId,
        mutedUntil: r.mutedUntil ? r.mutedUntil.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  @Post('channels/:channelId')
  @HttpCode(200)
  async setMute(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
    @Body() body: unknown,
  ) {
    const parsed = parseSetMuteBody(body);
    const row = await this.mutes.setMute({
      userId: user.id,
      channelId,
      mutedUntil: parsed.until,
    });
    return {
      channelId: row.channelId,
      mutedUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Delete('channels/:channelId')
  @HttpCode(204)
  async removeMute(
    @CurrentUser() user: CurrentUserPayload,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
  ) {
    await this.mutes.removeMute({ userId: user.id, channelId });
  }
}

function parseSetMuteBody(body: unknown): { until: Date | null } {
  if (body === null || body === undefined) return { until: null };
  if (typeof body !== 'object') {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'body must be an object');
  }
  const obj = body as { until?: unknown };
  if (obj.until === undefined || obj.until === null) {
    return { until: null };
  }
  if (typeof obj.until !== 'string') {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'until must be ISO string');
  }
  const date = new Date(obj.until);
  if (Number.isNaN(date.getTime())) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'until is not a valid ISO datetime');
  }
  // 과거 시점은 즉시 만료 — null 과 동치 처리 가능하나 그대로 저장.
  return { until: date };
}
