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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ListMessagesQuerySchema,
  SendMessageRequestSchema,
  UpdateMessageRequestSchema,
} from '@qufox/shared-types';
import { MessagesService } from './messages.service';
import { MessageAuthorGuard } from './guards/message-author.guard';
import { CurrentMessage, CurrentMessagePayload } from './decorators/current-message.decorator';
import { ChannelAccessGuard } from '../channels/guards/channel-access.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';

type WorkspaceRoleStr = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * Messages live under `/workspaces/:id/channels/:chid/messages`. The full
 * guard chain is:
 *   JwtAuthGuard (global) → WorkspaceMemberGuard (:id) → ChannelAccessGuard (:chid)
 * then PATCH adds MessageAuthorGuard and DELETE handles author-or-admin in
 * the service layer.
 *
 * Idempotency (POST only):
 *   - client sends `Idempotency-Key: <uuid>` (optional — sending the same
 *     request twice WITHOUT a key creates two rows, which matches the zero-key
 *     semantics of RFC draft-ietf-httpapi-idempotency-key-header)
 *   - server returns `Idempotency-Replayed: true` when the row already existed
 *   - mismatched content under the same key ⇒ 409 IDEMPOTENCY_KEY_REUSE_CONFLICT
 */
@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid/messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly rate: RateLimitService,
  ) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const parsed = ListMessagesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    if (parsed.data.includeDeleted && !this.isAdminOrOwner(m.role)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'ADMIN or OWNER required to list deleted messages',
      );
    }
    await this.rate.enforce([{ key: `msg:get:u:${user.id}`, windowSec: 60, max: 600 }]);
    const result = await this.messages.list({
      channelId,
      before: parsed.data.before,
      after: parsed.data.after,
      around: parsed.data.around,
      limit: parsed.data.limit,
      includeDeleted: parsed.data.includeDeleted ?? false,
    });
    // task-013-B: reactions join is one extra round-trip per page, not per
    // message. Empty page → skip the query entirely.
    const ids = result.items.map((r) => r.id);
    const [reactionMap, threadMap, attachmentMap] = await Promise.all([
      this.messages.aggregateReactions(ids, user.id),
      // task-014-B: thread summary join, same one-per-page round trip.
      this.messages.aggregateThreadSummaries(ids),
      // Inline attachments projection — same batched pattern so a page
      // of 50 messages costs one reactions / one thread / one attachment
      // query regardless of how many of them have media.
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
        nextCursor: result.nextCursor,
        prevCursor: result.prevCursor,
      },
    };
  }

  @Get(':msgId')
  async getOne(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    // Soft-delete visibility rule: non-admin members get 404 on deleted rows
    // (matches the list path's includeDeleted=false default). ADMIN+ can see
    // the row with content masked by `toDto`.
    const row = await this.messages.requireOne({
      channelId,
      msgId,
      includeDeleted: this.isAdminOrOwner(m.role),
    });
    const [rmap, amap] = await Promise.all([
      this.messages.aggregateReactions([row.id], user.id),
      this.messages.aggregateAttachments([row.id]),
    ]);
    return {
      message: this.messages.toDto(row, rmap.get(row.id) ?? [], null, amap.get(row.id) ?? []),
    };
  }

  @Post()
  async send(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = SendMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.MESSAGE_CONTENT_INVALID, parsed.error.message);
    }
    await this.rate.enforce([
      { key: `msg:send:u:${user.id}`, windowSec: 10, max: this.rateUserMax() },
      { key: `msg:send:c:${channelId}`, windowSec: 10, max: this.rateChannelMax() },
    ]);
    const idempotencyKey = validateIdempotencyKey(idempotencyHeader);
    const { message, replayed } = await this.messages.send({
      workspaceId: m.workspaceId,
      channelId,
      authorId: user.id,
      content: parsed.data.content,
      idempotencyKey,
      parentMessageId: parsed.data.parentMessageId ?? null,
    });
    if (replayed) res.setHeader('Idempotency-Replayed', 'true');
    res.status(replayed ? 200 : 201);
    return { message: this.messages.toDto(message) };
  }

  @UseGuards(MessageAuthorGuard)
  @Patch(':msgId')
  async update(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentMessage() _msg: CurrentMessagePayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.MESSAGE_CONTENT_INVALID, parsed.error.message);
    }
    const row = await this.messages.update({
      workspaceId: m.workspaceId,
      channelId,
      msgId,
      actorId: user.id,
      content: parsed.data.content,
    });
    const [rmap, amap] = await Promise.all([
      this.messages.aggregateReactions([row.id], user.id),
      this.messages.aggregateAttachments([row.id]),
    ]);
    return {
      message: this.messages.toDto(row, rmap.get(row.id) ?? [], null, amap.get(row.id) ?? []),
    };
  }

  // DELETE permits author OR ADMIN+. MessageAuthorGuard is intentionally NOT
  // applied here — the service branches on `actorId === authorId || isAdmin`.
  @Delete(':msgId')
  @HttpCode(204)
  async softDelete(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    // Include deleted rows here so "delete already-deleted" is idempotent
    // (returns 204) regardless of caller role.
    const row = await this.messages.requireOne({ channelId, msgId, includeDeleted: true });
    if (row.deletedAt) return; // idempotent
    const isSelf = row.authorId === user.id;
    const isMod = this.isAdminOrOwner(m.role);
    if (!isSelf && !isMod) {
      throw new DomainError(
        ErrorCode.MESSAGE_NOT_AUTHOR,
        'only the author or an ADMIN can delete this message',
      );
    }
    await this.messages.softDelete({
      workspaceId: m.workspaceId,
      channelId,
      msgId,
      actorId: user.id,
    });
  }

  // -----

  private isAdminOrOwner(role: WorkspaceRoleStr): boolean {
    return role === 'ADMIN' || role === 'OWNER';
  }

  private rateUserMax(): number {
    return Number(process.env.MESSAGE_RATE_USER_MAX ?? 30);
  }

  private rateChannelMax(): number {
    return Number(process.env.MESSAGE_RATE_CHANNEL_MAX ?? 60);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateIdempotencyKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!UUID_RE.test(trimmed)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key must be a UUID');
  }
  return trimmed;
}
