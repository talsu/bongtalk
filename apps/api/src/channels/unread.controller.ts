import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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

  /**
   * 072 백로그 S-I (FR-RS-10 / N6-1): Unreads 미리보기. 미읽(>0) 채널 + 채널별 최근 미읽
   * 메시지 ≤5(작성자 + 본문 미리보기, 차단 마스킹) + cursor 페이지네이션. 워크스페이스 멤버
   * 누구나(summarize 가 채널별 READ ACL 을 이미 강제). cursor/limit 은 쿼리 파라미터.
   */
  @Get('unreads')
  async unreads(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe('')) limitRaw?: string,
  ): Promise<Awaited<ReturnType<UnreadService['previewUnreads']>>> {
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return this.unread.previewUnreads(
      m.workspaceId,
      user.id,
      cursor && cursor.length > 0 ? cursor : undefined,
      Number.isFinite(limit) ? limit : undefined,
    );
  }
}

@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid')
export class ChannelReadController {
  constructor(private readonly unread: UnreadService) {}

  /**
   * @deprecated S11 (FR-RT-13): use POST .../ack with an explicit
   * `lastReadMessageId` instead. This endpoint is retained for backward
   * compatibility; it now marks everything up to the channel's latest
   * message as read via the same monotonic (createdAt, id) tuple cursor
   * (UnreadService.markRead → ackRead), so the unread formula stays
   * consistent. ChannelAccessGuard scopes the channel to the caller's
   * workspace + read-perm.
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
