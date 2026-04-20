import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ListThreadRepliesQuerySchema } from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { MessagesService } from './messages.service';
import { cursorFor, decodeCursor } from './cursor/cursor';

/**
 * Task-014-B: thread replies endpoint. Path is `/messages/:id/thread`
 * at the top level (no workspace / channel prefix) for the same reason
 * as reactions — the message id is globally unique and the workspace +
 * channel are derived inside. Keeps the client's URL construction
 * symmetric between the thread panel and reactions.
 */
@UseGuards(JwtAuthGuard)
@Controller('messages')
export class ThreadsController {
  constructor(
    private readonly messages: MessagesService,
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
    private readonly channelAccess: ChannelAccessByIdGuard,
  ) {}

  @Get(':id/thread')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    // Same generous GET budget as the main messages list. Thread panel
    // scroll-to-top triggers refetch; cap keeps misbehaving clients from
    // hot-looping.
    await this.rate.enforce([{ key: `thread:get:u:${user.id}`, windowSec: 60, max: 600 }]);
    const parsed = ListThreadRepliesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }

    // Resolve channel via the message id so the controller can run the
    // same ACL check path reactions use. The message must still exist;
    // soft-deleted roots surface `MESSAGE_NOT_FOUND` so the UI closes
    // the panel.
    const msg = await this.prisma.message.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        channelId: true,
        parentMessageId: true,
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
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'thread root not found');
    }
    await this.channelAccess.requireRead(msg.channel, user.id);

    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    const page = await this.messages.listThreadReplies({
      channelId: msg.channelId,
      rootId: id,
      cursor,
      limit: parsed.data.limit,
    });

    const ids = [page.root.id, ...page.items.map((r) => r.id)];
    // Reactions on both the root + replies for a single-query join.
    const reactions = await this.messages.aggregateReactions(ids, user.id);
    const rootSummary = (await this.messages.aggregateThreadSummaries([page.root.id])).get(
      page.root.id,
    );

    return {
      root: this.messages.toDto(page.root, reactions.get(page.root.id) ?? [], rootSummary ?? null),
      replies: page.items.map((r) =>
        this.messages.toDto(r, reactions.get(r.id) ?? [], null /* replies are leaves */),
      ),
      pageInfo: {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
          ? cursorFor({ id: page.nextCursor.id, createdAt: page.nextCursor.t })
          : null,
        prevCursor: page.prevCursor
          ? cursorFor({ id: page.prevCursor.id, createdAt: page.prevCursor.t })
          : null,
      },
    };
  }
}
