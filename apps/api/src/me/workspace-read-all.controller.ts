import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  CurrentMember,
  CurrentMemberPayload,
} from '../workspaces/decorators/current-member.decorator';
import { WorkspaceMemberGuard } from '../workspaces/guards/workspace-member.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { UnreadService } from '../channels/unread.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * S23 (FR-RS-11): POST /workspaces/:id/read-all — 워크스페이스 전체 읽음
 * (Shift+Esc 단축키 백엔드). 호출자가 읽을 수 있는 채널 중 미읽이 남은
 * 채널을 각각 최신 메시지까지 monotonic 하게 읽음 처리하고, 채널별
 * read_state:updated 를 호출자의 user 룸으로 fan-out 한다(멀티세션 배지 동기화).
 *
 * ChannelAckController 와 같은 이유(RealtimeGateway emit 의존)로 MeModule 에
 * 둔다 — ChannelsModule 은 RealtimeModule 을 import 하지 않으므로(순환 방지)
 * gateway 를 inject 할 컨트롤러는 MeModule 이 호스트다. 채널 단위 가드(chid)가
 * 없어 WorkspaceMemberGuard 만 적용하고, 채널 가시성/ACL 은 UnreadService.
 * summarize 가 단일 출처로 거른다(읽을 수 없는 채널은 애초에 집계되지 않음).
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
  ): Promise<{ channelsRead: number }> {
    const payloads = await this.unread.markAllRead(user.id, m.workspaceId);
    for (const payload of payloads) {
      this.gateway.emitReadStateUpdated(user.id, payload);
    }
    return { channelsRead: payloads.length };
  }
}
