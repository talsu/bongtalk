import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ChannelAccessGuard } from './guards/channel-access.guard';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { UnreadService } from './unread.service';

@UseGuards(WorkspaceMemberGuard)
@Controller('workspaces/:id')
export class UnreadSummaryController {
  constructor(private readonly unread: UnreadService) {}

  /**
   * GET /workspaces/:id/unread-summary — one row per channel the caller
   * can read. Task-010-B contract.
   */
  @Get('unread-summary')
  async summary(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ channels: Awaited<ReturnType<UnreadService['summarize']>> }> {
    const channels = await this.unread.summarize(m.workspaceId, user.id);
    return { channels };
  }
}

@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid')
export class ChannelReadController {
  constructor(private readonly unread: UnreadService) {}

  /**
   * POST /workspaces/:id/channels/:chid/read — stamp `lastReadAt = now()`
   * for (caller, channel). Task-010-B: frontend calls this from a
   * 500ms debounced scroll-to-bottom listener. ChannelAccessGuard
   * scopes the channel to the caller's workspace + read-perm.
   */
  @Post('read')
  @HttpCode(204)
  async markRead(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.unread.markRead(user.id, channelId);
  }
}
