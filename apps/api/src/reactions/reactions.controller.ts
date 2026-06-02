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
import type { ListReactionsResponse } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { MessagesService } from '../messages/messages.service';
import { ReactionsService } from './reactions.service';

/**
 * Task-013-B / S39 (D05): POST(toggle) / DELETE / GET reactions. Path is
 * `/messages/:id` at the top level (no workspace/channel prefix) because the
 * message id is globally unique and the channel + workspace are derived
 * inside — keeps the URL stable for the realtime dispatcher.
 */
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class ReactionsController {
  constructor(
    private readonly reactions: ReactionsService,
    private readonly messages: MessagesService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly channelAccess: ChannelAccessByIdGuard,
  ) {}

  private async resolveChannel(messageId: string) {
    const msg = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null },
      select: {
        id: true,
        channelId: true,
        channel: {
          select: {
            id: true,
            workspaceId: true,
            isPrivate: true,
            archivedAt: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!msg || !msg.channel || msg.channel.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    }
    // S39 fix-forward (security MEDIUM): 보관(archived) 채널은 반응 추가/제거/조회를
    // 모두 막는다. 종전엔 archivedAt 을 SELECT 만 하고 거부하지 않아 attachments
    // 컨트롤러·threads 컨트롤러·ChannelAccessGuard 의 CHANNEL_ARCHIVED 패턴과
    // 어긋나 있었다(보관 채널에 새 반응이 쌓이는 회귀). resolveChannel 한 곳에서
    // 막아 POST / DELETE / GET 이 일관되게 409 로 수렴하게 한다. 존재 leak 을
    // 피하려면 READ ACL 통과 뒤 검사하는 편이 깔끔하지만, archived 는 멤버에게도
    // 동일하게 노출되는 채널 상태라(존재가 이미 가시) 여기서 막아도 leak 이 없다.
    if (msg.channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived — unarchive first');
    }
    return { messageId: msg.id, channel: msg.channel };
  }

  /**
   * S39 (FR-RE01): single-call toggle. 내 반응이 있으면 제거, 없으면 추가하고
   * 항상 200 + 현재 집계({ emoji, count, byMe })를 돌려준다. 클라이언트 api.ts 는
   * 이 단일 POST 만 호출한다(별도 DELETE 분기 불필요 — 자기 토글).
   */
  @Post(':id/reactions')
  @HttpCode(200)
  async toggle(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { emoji: string },
  ): Promise<{ emoji: string; count: number; byMe: boolean }> {
    // Task-013-B rate limit: 60 reactions / minute per user.
    await this.rateLimit.enforce([{ key: `reactions:${user.id}`, windowSec: 60, max: 60 }]);
    const { messageId, channel } = await this.resolveChannel(id);
    // READ bit (not WRITE) — reacting is lighter than posting.
    await this.channelAccess.requireRead(channel, user.id);
    const result = await this.reactions.add(
      messageId,
      channel.id,
      channel.workspaceId,
      user.id,
      body?.emoji ?? '',
    );
    return result;
  }

  /**
   * S39 (FR-RE04): GET /messages/:id/reactions — emoji별 { emoji, count,
   * users:[…최대 5명] } 집계. 채널 READ ACL 적용. 전체 reactor cursor 페이지네이션은
   * FR-RE05(S40 carryover).
   */
  @Get(':id/reactions')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ListReactionsResponse> {
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    const reactions = await this.messages.aggregateReactionDetails(messageId);
    return { reactions };
  }

  @Delete(':id/reactions/:emoji')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('emoji') emoji: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.rateLimit.enforce([{ key: `reactions:${user.id}`, windowSec: 60, max: 60 }]);
    const { messageId, channel } = await this.resolveChannel(id);
    await this.channelAccess.requireRead(channel, user.id);
    await this.reactions.remove(
      messageId,
      channel.id,
      channel.workspaceId,
      user.id,
      decodeURIComponent(emoji),
    );
  }
}
