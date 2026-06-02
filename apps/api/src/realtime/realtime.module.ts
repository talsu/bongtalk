import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { WsAuthMiddleware } from './handshake/ws-auth.middleware';
import { RoomManagerService } from './rooms/room-manager.service';
import { PresenceModule } from './presence/presence.module';
import { PresenceThrottler } from './presence/presence-throttler';
import { PresenceGraceTimers } from './presence/presence-grace-timers';
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
// S39 (FR-RE03): OutboxToWsSubscriber 가 message.reaction.updated 수신 시
// MessagesService.aggregateReactionDetails 로 집계+users[5] enrichment 한다.
// MessagesModule 은 RealtimeModule 을 import 하지 않으므로 순환 없음(단방향).
import { MessagesModule } from '../messages/messages.module';
// S47 (D06 / FR-MN-20): OutboxToWsSubscriber 가 멘션 발생 시 서버 진실값 배지를
// 재집계해 notification:badge_update 로 emit 한다. 경량 전용 모듈이라 MeModule ↔
// RealtimeModule 순환 없이 배지 집계 단일 출처를 공유한다.
import { MeNotificationBadgesModule } from '../me/me-notification-badges.module';

@Module({
  imports: [AuthModule, ChannelsModule, PresenceModule, MessagesModule, MeNotificationBadgesModule],
  providers: [
    RealtimeGateway,
    WsAuthMiddleware,
    RoomManagerService,
    PresenceThrottler,
    PresenceGraceTimers,
    TypingService,
    ReplayBufferService,
    ChannelSeqService,
    OutboxToWsSubscriber,
    MembershipRevocationListener,
  ],
  // S27: PresenceService 는 PresenceModule 재노출(re-export)로 외부에 제공한다.
  exports: [RealtimeGateway, PresenceModule, TypingService, ChannelSeqService],
})
export class RealtimeModule {}
