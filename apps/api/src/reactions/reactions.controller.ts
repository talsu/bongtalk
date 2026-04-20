import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { ReactionsService } from './reactions.service';

/**
 * Task-013-B: POST/DELETE reactions. Path is `/messages/:id` at the
 * top level (no workspace/channel prefix) because the message id is
 * globally unique and the channel + workspace are derived inside —
 * keeps the URL stable for the realtime dispatcher.
 */
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class ReactionsController {
  constructor(
    private readonly reactions: ReactionsService,
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
    return { messageId: msg.id, channel: msg.channel };
  }

  @Post(':id/reactions')
  async add(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { emoji: string },
    @Res({ passthrough: true }) res: Response,
  ) {
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
    // Idempotent POST convention: 201 on first create, 200 when replaying
    // an existing (message, user, emoji) row. Mirrors the message-send
    // idempotency contract so clients can reason about "did I cause this"
    // uniformly across endpoints.
    res.status(result.created ? 201 : 200);
    return { emoji: result.emoji, count: result.count, byMe: true };
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
