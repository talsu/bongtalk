import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  AckReadRequestSchema,
  MarkUnreadRequestSchema,
  type ReadStateUpdatedPayload,
} from '@qufox/shared-types';
import { ChannelAccessGuard } from '../channels/guards/channel-access.guard';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { UnreadService } from '../channels/unread.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S11 (FR-RT-13): POST /workspaces/:id/channels/:chid/ack.
 *
 * Body `{ lastReadMessageId, clientTimestamp? }`. Validates the message
 * belongs to the channel (else 404 MESSAGE_NOT_FOUND), runs the monotonic
 * (createdAt, id) tuple upsert (cursor 퇴행 방지), recomputes unreadCount,
 * and emits `read_state:updated{channelId, lastReadMessageId, unreadCount}`
 * to the caller's `user:{userId}` room so other devices/tabs sync.
 *
 * 5초 debounce 는 프론트(클라) 책임 — S11 backend 범위 밖이다. 서버는 매 ack 를
 * monotonic 하게 처리하므로 클라가 debounce 를 빠뜨려도 안전하다(퇴행 무시).
 *
 * Lives in MeModule (not ChannelsModule) because it injects RealtimeGateway
 * to emit, and ChannelsModule must NOT import RealtimeModule (RealtimeModule
 * already imports ChannelsModule for the gateway's UnreadService — keeping
 * the dependency one-directional avoids a cycle). MeModule already imports
 * both, so it is the natural host.
 */
@UseGuards(WorkspaceMemberGuard, ChannelAccessGuard)
@Controller('workspaces/:id/channels/:chid')
export class ChannelAckController {
  constructor(
    private readonly unread: UnreadService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Post('ack')
  @HttpCode(200)
  async ack(
    @Param('id', new ParseUUIDPipe()) wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<ReadStateUpdatedPayload> {
    const parsed = AckReadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // NIT-G: route param 으로 보유한 workspaceId 를 전달 — ackRead 가
    // channel→workspaceId SELECT 를 생략하고 페이로드에 실어 dispatcher 가
    // keyed unread-summary 쿼리를 직접 patch 한다.
    const payload = await this.unread.ackRead({
      userId: user.id,
      channelId,
      lastReadMessageId: parsed.data.lastReadMessageId,
      workspaceId: wsId,
    });
    this.gateway.emitReadStateUpdated(user.id, payload);
    return payload;
  }

  /**
   * S24 (FR-RS-08): POST /workspaces/:id/channels/:chid/unread — 수동 읽지 않음 표시.
   *
   * Body `{ messageId }`. 해당 메시지 **직전** 메시지로 lastReadMessageId 를
   * 되돌린다(직전이 없으면 null = 전체 읽지 않음). S21 monotonic guard 를 의도적으로
   * 우회하는 후진 경로(UnreadService.markUnread → setCursorBackward)이며, 새
   * unread/mention 카운트를 실은 read_state:updated 를 user 룸으로 fan-out 해
   * 멀티세션 사이드바 배지를 동기화한다. ack 와 동일 가드/모듈 호스팅 이유.
   */
  @Post('unread')
  @HttpCode(200)
  async markUnread(
    @Param('id', new ParseUUIDPipe()) wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<ReadStateUpdatedPayload> {
    const parsed = MarkUnreadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const payload = await this.unread.markUnread({
      userId: user.id,
      channelId,
      messageId: parsed.data.messageId,
      workspaceId: wsId,
    });
    this.gateway.emitReadStateUpdated(user.id, payload);
    return payload;
  }

  /**
   * S24 fix-forward (reviewer MAJOR #3 · FR-RS-09): POST /workspaces/:id/channels/
   * :chid/read-ack — 채널을 최신까지 읽음 처리하고 read_state:updated 를 user 룸으로
   * **emit** 한다. 채널 컨텍스트 메뉴 "읽음으로 표시"(ChannelList) + Unreads "읽음
   * 처리"(UnreadsView) 가 종전 `POST .../read`(markRead, emit 안 함) 대신 이 경로를
   * 써 멀티세션 사이드바 배지를 동기화한다. 메시지가 없는 채널은 payload 가 null
   * 이라 emit 하지 않는다(읽지 않음이 애초에 0). ack 와 동일 가드/모듈 호스팅 이유.
   */
  @Post('read-ack')
  @HttpCode(200)
  async readAck(
    @Param('id', new ParseUUIDPipe()) wsId: string,
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ReadStateUpdatedPayload | { channelId: string; unreadCount: number }> {
    const payload = await this.unread.markChannelReadToLatest(user.id, channelId, wsId);
    if (!payload) {
      return { channelId, unreadCount: 0 };
    }
    this.gateway.emitReadStateUpdated(user.id, payload);
    return payload;
  }
}
