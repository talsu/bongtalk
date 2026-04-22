import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { MeActivityService, type ActivityPage, type UnreadCounts } from './me-activity.service';

type Filter = 'all' | 'mentions' | 'replies' | 'reactions' | 'directs';

function normalizeFilter(raw: string | undefined): Filter {
  if (raw === 'mentions' || raw === 'replies' || raw === 'reactions' || raw === 'directs') {
    return raw;
  }
  return 'all';
}

/**
 * task-026-A: Activity inbox endpoints. All reads under /me/activity are
 * auth'd; cursor is opaque `<iso>|<activityKey>` produced by the service.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/activity')
export class MeActivityController {
  constructor(private readonly svc: MeActivityService) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('filter') filter: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(25)) limitRaw: string | number,
  ): Promise<ActivityPage> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    return this.svc.page(user.id, normalizeFilter(filter), cursor ?? null, limit || 25);
  }

  @Get('unread-counts')
  async unreadCounts(@CurrentUser() user: CurrentUserPayload): Promise<UnreadCounts> {
    return this.svc.unreadCounts(user.id);
  }

  @Post(':activityKey/read')
  @HttpCode(204)
  async markRead(
    @CurrentUser() user: CurrentUserPayload,
    @Param('activityKey') activityKey: string,
  ): Promise<void> {
    await this.svc.markRead(user.id, activityKey);
  }

  @Post('read-all')
  async markAllRead(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { filter?: string } | undefined,
  ): Promise<{ count: number }> {
    return this.svc.markAllRead(user.id, normalizeFilter(body?.filter));
  }
}
