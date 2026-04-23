import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DirectMessagesService, type DmListItem } from './direct-messages.service';

/**
 * task-033-B: global DM endpoints under /me/dms. Same service as the
 * 027 /me/workspaces/:wsId/dms path but with workspaceId=null
 * (friend-gated, no workspace). The 027 controller is kept intact and
 * marked deprecated at the response header level.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/dms')
export class GlobalDmController {
  constructor(private readonly svc: DirectMessagesService) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(50)) limitRaw: string | number,
  ): Promise<{ items: DmListItem[] }> {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    const items = await this.svc.list(null, user.id, limit || 50);
    return { items };
  }

  @Get('by-user/:userId')
  async findByUser(
    @CurrentUser() user: CurrentUserPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<{ channelId: string | null }> {
    const hit = await this.svc.findByUser(null, user.id, userId);
    return { channelId: hit?.channelId ?? null };
  }

  @Post()
  async createOrGet(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId?: string },
  ): Promise<{ channelId: string; created: boolean }> {
    const otherUserId = body?.userId;
    if (!otherUserId) {
      return { channelId: '', created: false };
    }
    return this.svc.createOrGetGlobal(user.id, otherUserId);
  }
}
