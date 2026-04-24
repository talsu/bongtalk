import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ListMessagesQuerySchema,
  SendMessageRequestSchema,
  UpdateMessageRequestSchema,
} from '@qufox/shared-types';
import { MessagesService } from './messages.service';
import { DmChannelAccessGuard } from './guards/dm-channel-access.guard';
import { MessageAuthorGuard } from './guards/message-author.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { Permission } from '../auth/permissions';
import { validateIdempotencyKey } from './idempotency';

/**
 * Global DM message surface — list / send / update / delete under
 * `/me/dms/:channelId/messages`. Independent of WorkspaceMemberGuard,
 * so a zero-workspace user (who only lives in friendships) can still
 * DM a friend. The DmChannelAccessGuard resolves USER-level ALLOW
 * overrides directly and attaches the effective mask to the request
 * so mutations can re-check WRITE / DELETE_OWN inline.
 *
 * Reuses MessagesService — which now accepts `workspaceId: string | null`
 * and passes null through for Global DM channels — so message payloads
 * remain consistent across the workspaceful and workspaceless paths.
 */
@UseGuards(JwtAuthGuard, DmChannelAccessGuard)
@Controller('me/dms/:channelId/messages')
export class GlobalDmMessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly rate: RateLimitService,
  ) {}

  private readChannel(req: Request): { id: string; workspaceId: string | null } {
    const ch = (req as unknown as { channel?: { id: string; workspaceId: string | null } }).channel;
    if (!ch) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not resolved');
    }
    return ch;
  }

  private readEffectiveMask(req: Request): number {
    return (req as unknown as { dmChannelEffectiveMask?: number }).dmChannelEffectiveMask ?? 0;
  }

  @Get()
  async list(
    @Req() req: Request,
    @CurrentUser() user: CurrentUserPayload,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const channel = this.readChannel(req);
    const parsed = ListMessagesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.rate.enforce([{ key: `msg:get:u:${user.id}`, windowSec: 60, max: 600 }]);
    const result = await this.messages.list({
      channelId: channel.id,
      before: parsed.data.before,
      after: parsed.data.after,
      around: parsed.data.around,
      limit: parsed.data.limit,
      includeDeleted: false,
    });
    const ids = result.items.map((r) => r.id);
    const [reactionMap, threadMap, attachmentMap] = await Promise.all([
      this.messages.aggregateReactions(ids, user.id),
      this.messages.aggregateThreadSummaries(ids),
      this.messages.aggregateAttachments(ids),
    ]);
    return {
      items: result.items.map((r) =>
        this.messages.toDto(
          r,
          reactionMap.get(r.id) ?? [],
          threadMap.get(r.id) ?? null,
          attachmentMap.get(r.id) ?? [],
        ),
      ),
      pageInfo: {
        hasMore: result.hasMore,
        prevCursor: result.prevCursor,
        nextCursor: result.nextCursor,
      },
    };
  }

  @Post()
  async send(
    @Req() req: Request,
    @CurrentUser() user: CurrentUserPayload,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const channel = this.readChannel(req);
    const effective = this.readEffectiveMask(req);
    if ((effective & Permission.WRITE_MESSAGE) !== Permission.WRITE_MESSAGE) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'cannot write to this DM');
    }
    const parsed = SendMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.MESSAGE_CONTENT_INVALID, parsed.error.message);
    }
    await this.rate.enforce([
      { key: `msg:send:u:${user.id}`, windowSec: 10, max: 20 },
      { key: `msg:send:c:${channel.id}`, windowSec: 10, max: 40 },
    ]);
    const idempotencyKey = validateIdempotencyKey(idempotencyHeader);
    const { message, replayed } = await this.messages.send({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      authorId: user.id,
      content: parsed.data.content,
      idempotencyKey,
      parentMessageId: parsed.data.parentMessageId ?? null,
      attachmentIds: parsed.data.attachmentIds,
    });
    if (replayed) res.setHeader('Idempotency-Replayed', 'true');
    res.status(replayed ? 200 : 201);
    return { message: this.messages.toDto(message) };
  }

  @UseGuards(MessageAuthorGuard)
  @Patch(':msgId')
  async update(
    @Req() req: Request,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const channel = this.readChannel(req);
    const parsed = UpdateMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.MESSAGE_CONTENT_INVALID, parsed.error.message);
    }
    const updated = await this.messages.update({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      msgId,
      actorId: user.id,
      content: parsed.data.content,
    });
    return { message: this.messages.toDto(updated) };
  }

  @Delete(':msgId')
  @HttpCode(204)
  async remove(
    @Req() req: Request,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    const channel = this.readChannel(req);
    const effective = this.readEffectiveMask(req);
    const row = await this.messages.requireOne({
      channelId: channel.id,
      msgId,
      includeDeleted: true,
    });
    if (row.authorId !== user.id) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_AUTHOR, 'not the message author');
    }
    if ((effective & Permission.DELETE_OWN_MESSAGE) !== Permission.DELETE_OWN_MESSAGE) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'delete permission not granted');
    }
    await this.messages.softDelete({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      msgId,
      actorId: user.id,
    });
  }
}
