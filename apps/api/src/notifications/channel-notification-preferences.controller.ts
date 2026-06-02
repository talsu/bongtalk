import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { PutChannelNotificationPreferenceRequestSchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { ChannelAccessGuard } from '../channels/guards/channel-access.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { NotifPreferencesService } from './notif-preferences.service';

/**
 * S46 (D06 / FR-MN-07): 채널 단위 알림 오버라이드 API.
 *
 *   GET    /workspaces/:id/channels/:chid/notification-preferences
 *   PUT    /workspaces/:id/channels/:chid/notification-preferences
 *   DELETE /workspaces/:id/channels/:chid/notification-preferences  (채널 뮤트 해제)
 *
 * 권한: WorkspaceMemberGuard + ChannelAccessGuard(READ — VIEW_CHANNEL). 채널이
 * VIEW 가능해야 설정할 수 있다(favorites 와 동일 가드 체인). PUT 의 categoryId 가
 * 있으면 해당 카테고리 하위 채널 전체에 일괄 적용한다(FR-MN-07). 채널 오버라이드는
 * 기존 UserChannelMute 에 level 컬럼을 더한 deviation 으로 표현한다.
 */
@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid/notification-preferences')
export class ChannelNotificationPreferencesController {
  constructor(private readonly prefs: NotifPreferencesService) {}

  @Get()
  async get(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.prefs.getChannel(user.id, channelId);
  }

  @Put()
  async put(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = PutChannelNotificationPreferenceRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const { categoryId, ...patch } = parsed.data;
    if (categoryId) {
      // FR-MN-07: 카테고리 일괄 적용. 하위 채널 전체 bulk upsert.
      const channelIds = await this.prefs.putCategoryChannels(
        user.id,
        categoryId,
        patch,
        new Date(),
      );
      return { categoryId, channelIds };
    }
    return this.prefs.putChannel(user.id, channelId, patch, new Date());
  }

  @Delete()
  async unmute(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.prefs.unmuteChannel(user.id, channelId);
  }
}
