import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { WsAuthMiddleware } from './handshake/ws-auth.middleware';
import { RoomManagerService } from './rooms/room-manager.service';
import { PresenceService } from './presence/presence.service';
import { PresenceThrottler } from './presence/presence-throttler';
import { TypingService } from './typing/typing.service';
import { ReplayBufferService } from './projection/replay-buffer.service';
import { ChannelSeqService } from './projection/channel-seq.service';
import { OutboxToWsSubscriber } from './projection/outbox-to-ws.subscriber';
import { MembershipRevocationListener } from './projection/membership-revocation.listener';
// PresenceService unused by the trimmed listener — re-import only if a new
// revocation path needs it.
import { AuthModule } from '../auth/auth.module';
// S11 (FR-RT-13/14/19): gateway 의 channel:read 핸들러가 UnreadService(read-sync
// 공식 단일 출처)를 inject 한다. ChannelsModule 은 RealtimeModule 을 import 하지
// 않으므로 순환 없음(단방향).
import { ChannelsModule } from '../channels/channels.module';

@Module({
  imports: [AuthModule, ChannelsModule],
  providers: [
    RealtimeGateway,
    WsAuthMiddleware,
    RoomManagerService,
    PresenceService,
    PresenceThrottler,
    TypingService,
    ReplayBufferService,
    ChannelSeqService,
    OutboxToWsSubscriber,
    MembershipRevocationListener,
  ],
  exports: [RealtimeGateway, PresenceService, TypingService, ChannelSeqService],
})
export class RealtimeModule {}
