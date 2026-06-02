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
import { PutServerNotificationPreferenceRequestSchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { NotifPreferencesService } from './notif-preferences.service';

/**
 * S46 (D06 / FR-MN-06): 서버(워크스페이스) 단위 알림 오버라이드 API.
 *
 *   GET    /workspaces/:id/notification-preferences  → 서버 설정(행 없으면 기본).
 *   PUT    /workspaces/:id/notification-preferences  → upsert(level/isMuted/기간/suppress).
 *   DELETE /workspaces/:id/notification-preferences  → 서버 뮤트 해제(isMuted=false).
 *
 * 권한: WorkspaceMemberGuard — 멤버만 자기 설정을 조작한다(개인 상태라 ADMIN
 * 불요). 뮤트 기간은 15분/1시간/8시간/24시간/영구(muteDuration). suppress* 는
 * S46 에서 저장만(@everyone 게이트 연동은 후속).
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
@Controller('workspaces/:id/notification-preferences')
export class ServerNotificationPreferencesController {
  constructor(private readonly prefs: NotifPreferencesService) {}

  @Get()
  async get(
    @Param('id', new ParseUUIDPipe()) workspaceId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.prefs.getServer(user.id, workspaceId);
  }

  @Put()
  async put(
    @Param('id', new ParseUUIDPipe()) workspaceId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = PutServerNotificationPreferenceRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.prefs.putServer(user.id, workspaceId, parsed.data, new Date());
  }

  @Delete()
  async unmute(
    @Param('id', new ParseUUIDPipe()) workspaceId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.prefs.unmuteServer(user.id, workspaceId);
  }
}
