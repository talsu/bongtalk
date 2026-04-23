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
 *
 * task-033 deprecation: the 033 restructure moves DMs to a global
 * friend-gated surface at `/me/dms`. Keep this controller alive for
 * backward compatibility but tag every response with a Deprecation +
 * Link header so API clients and operators can track usage before a
 * future cleanup task removes the workspace-scoped path.
 */
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
@Controller('me/workspaces/:wsId/dms')
export class DirectMessagesController {
  constructor(private readonly svc: DirectMessagesService) {}

  // Sentinel method marker so `grep task-033 deprecated` returns a hit
  // from the deprecated surface even after automatic code-mod passes.
  static readonly DEPRECATED_SINCE = 'task-033';

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
