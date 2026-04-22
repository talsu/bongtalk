import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { WorkspaceMemberGuard } from '../../workspaces/guards/workspace-member.guard';
import { DirectMessagesService, type DmListItem } from './direct-messages.service';

/**
 * task-027-A: DM endpoints live under /me/workspaces/:wsId/dms to
 * lean on the existing WorkspaceMemberGuard (the :wsId path segment
 * is what the guard expects).
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
@Controller('me/workspaces/:wsId/dms')
export class DirectMessagesController {
  constructor(private readonly svc: DirectMessagesService) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Param('wsId') wsId: string,
    @Query('limit', new DefaultValuePipe(50)) limitRaw: string | number,
  ): Promise<{ items: DmListItem[] }> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    const items = await this.svc.list(wsId, user.id, limit || 50);
    return { items };
  }

  @Get('by-user/:userId')
  async findByUser(
    @CurrentUser() user: CurrentUserPayload,
    @Param('wsId') wsId: string,
    @Param('userId') userId: string,
  ): Promise<{ channelId: string | null }> {
    const hit = await this.svc.findByUser(wsId, user.id, userId);
    return { channelId: hit?.channelId ?? null };
  }

  @Post()
  async createOrGet(
    @CurrentUser() user: CurrentUserPayload,
    @Param('wsId') wsId: string,
    @Body() body: { userId?: string },
  ): Promise<{ channelId: string; created: boolean }> {
    const otherUserId = body?.userId;
    if (!otherUserId) {
      return { channelId: '', created: false };
    }
    return this.svc.createOrGet(wsId, user.id, otherUserId);
  }
}
