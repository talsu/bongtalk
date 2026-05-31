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

  // S17 perf (review): DmChannelAccessGuard 가 채널을 로드할 때 type/name 까지
  // select 해 req.channel 에 실어둔다. 반환 타입을 확장해 send/edit 차단 게이트가
  // 채널을 다시 SELECT 하지 않고 이 메타를 그대로 넘길 수 있게 한다.
  private readChannel(req: Request): {
    id: string;
    workspaceId: string | null;
    type: string;
    name: string | null;
  } {
    const ch = (
      req as unknown as {
        channel?: { id: string; workspaceId: string | null; type: string; name: string | null };
      }
    ).channel;
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
    // S03 (FR-MSG-21): reject lastReadMessageId as a pagination cursor.
    if (rawQuery.lastReadMessageId !== undefined) {
      throw new DomainError(
        ErrorCode.MESSAGE_CURSOR_INVALID,
        'lastReadMessageId is a read-state cursor and cannot be used for pagination — use the opaque before/after token',
      );
    }
    const parsed = ListMessagesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.rate.enforce([{ key: `msg:get:u:${user.id}`, windowSec: 60, max: 600 }]);
    // S17 (FR-DM-17 / FR-TH-19): 요청자 DM 가시성 하한선 + (FR-DM-18) 차단
    // 사용자 집합을 메시지 조회 전에 단일 SELECT 씩 로드한다(N+1 회피).
    const [visibleFrom, blockedIds] = await Promise.all([
      this.messages.resolveDmVisibleFrom(channel.id, user.id),
      this.messages.loadBlockedUserIds(user.id),
    ]);
    const result = await this.messages.list({
      channelId: channel.id,
      before: parsed.data.before,
      after: parsed.data.after,
      around: parsed.data.around,
      limit: parsed.data.limit,
      includeDeleted: false,
      visibleFrom,
    });
    const ids = result.items.map((r) => r.id);
    const [reactionMap, threadMap, attachmentMap] = await Promise.all([
      this.messages.aggregateReactions(ids, user.id),
      this.messages.aggregateThreadSummaries(ids),
      this.messages.aggregateAttachments(ids),
    ]);
    const dtos = result.items.map((r) =>
      this.messages.toDto(
        r,
        reactionMap.get(r.id) ?? [],
        threadMap.get(r.id) ?? null,
        attachmentMap.get(r.id) ?? [],
      ),
    );
    return {
      // S17 (FR-DM-18): 그룹 DM 에서 차단한 사용자의 메시지를 placeholder 로
      // 마스킹한다(삭제 아님 — 자리 유지). 1:1 DM 은 보통 차단 시 send 자체가
      // 막히지만(FR-DM-13), 차단 이전 히스토리에 상대 메시지가 남아있을 수
      // 있어 동일 마스킹을 적용한다.
      items: this.messages.maskBlockedAuthors(dtos, blockedIds),
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
    // S17 (FR-DM-13): 이미 열린 1:1 DM 에 send 시점 BLOCKED 재검증. S16
    // assertCanDm 는 개설 시점만 검사하므로, 그 이후 차단된 경우를 send 경로에서
    // 매번 막는다. guard 가 이미 로드한 채널 메타를 넘겨 중복 SELECT 를 없앤다.
    // 그룹 DM·비-DIRECT 는 메서드 내부에서 무동작/스킵.
    await this.messages.assertNotBlockedForDmSend(channel.id, user.id, {
      type: channel.type,
      name: channel.name,
    });
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
      // S03 (FR-MSG-04): clientNonce echo for optimistic swap.
      nonce: parsed.data.nonce ?? null,
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
    // S17 MAJOR (edit bypasses send-block gate): 1:1 DM 편집(PATCH)도 send 와
    // 동일하게 BLOCKED 게이트를 건다. 게이트가 없으면 차단 후에도 편집이 가능해
    // message.updated 가 피차단자에게 push 된다. guard 가 로드한 채널 메타로
    // 추가 SELECT 없이 판정(그룹 DM·비-DIRECT 는 내부 스킵).
    await this.messages.assertNotBlockedForDmSend(channel.id, user.id, {
      type: channel.type,
      name: channel.name,
    });
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
      // S05 (FR-MSG-06): DM 편집도 동일하게 낙관적 잠금. 불일치 시 409 +
      // 현재 DTO(details.current)를 service 가 throw.
      expectedVersion: parsed.data.expectedVersion,
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
