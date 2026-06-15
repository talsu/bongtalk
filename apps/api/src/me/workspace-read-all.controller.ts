import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { UndoMarkAllReadRequestSchema } from '@qufox/shared-types';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { UnreadService } from '../channels/unread.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S23 (FR-RS-11) / S24 (FR-RS-18): POST /workspaces/:id/read-all — 워크스페이스
 * 전체 읽음. 호출자가 읽을 수 있는 채널 중 읽지 않음이 남은 채널을 각각 최신 메시지까지
 * monotonic 하게 읽음 처리하고, 채널별 read_state:updated 를 호출자의 user 룸으로
 * fan-out 한다(멀티세션 배지 동기화).
 *
 * S24 개정: UnreadService.markAllRead 가 (1) 직전 ChannelReadState 스냅샷 SELECT →
 * (2) Redis+DB 이중 저장(2단계 실패 시 ACK 미진행 + 500) → (3) set-based ACK 순서로
 * 실행하고 snapshotId 를 반환한다. 응답의 snapshotId 로 웹 Undo 토스트가 5초 안에
 * POST .../read-all/undo 를 호출한다.
 *
 * ChannelAckController 와 같은 이유(RealtimeGateway emit 의존)로 MeModule 에
 * 둔다 — ChannelsModule 은 RealtimeModule 을 import 하지 않으므로(순환 방지)
 * gateway 를 inject 할 컨트롤러는 MeModule 이 호스트다. 채널 단위 가드(chid)가
 * 없어 WorkspaceMemberGuard 만 적용하고, 채널 가시성/ACL 은 UnreadService 가
 * 단일 출처로 거른다(읽을 수 없는 채널은 애초에 스냅샷/ACK 대상이 아니다).
 */
@UseGuards(WorkspaceMemberGuard)
@Controller('workspaces/:id')
export class WorkspaceReadAllController {
  constructor(
    private readonly unread: UnreadService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Post('read-all')
  @HttpCode(200)
  async readAll(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<{ channelsRead: number; snapshotId: string }> {
    const { snapshotId, payloads } = await this.unread.markAllRead(user.id, m.workspaceId);
    for (const payload of payloads) {
      this.gateway.emitReadStateUpdated(user.id, payload);
    }
    return { channelsRead: payloads.length, snapshotId };
  }

  /**
   * S24 (FR-RS-18): POST /workspaces/:id/read-all/undo — read-all 직전 상태 복원.
   * Body `{ snapshotId }`. Redis 히트 → Redis, miss → DB 로 채널별 lastReadMessageId
   * 를 되돌린다(後進 허용 — markUnread 와 동일 비-monotonic 경로). 복원된 채널마다
   * read_state:updated 를 user 룸으로 fan-out 한다. 만료/위조 스냅샷은 404.
   */
  @Post('read-all/undo')
  @HttpCode(200)
  async undo(
    @Param('id', new ParseUUIDPipe()) _wsId: string,
    @CurrentMember() m: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<{ channelsRestored: number }> {
    const parsed = UndoMarkAllReadRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const payloads = await this.unread.undoMarkAllRead(
      user.id,
      m.workspaceId,
      parsed.data.snapshotId,
    );
    for (const payload of payloads) {
      this.gateway.emitReadStateUpdated(user.id, payload);
    }
    return { channelsRestored: payloads.length };
  }
}
