import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { WsAuthMiddleware } from './handshake/ws-auth.middleware';
import { RoomManagerService } from './rooms/room-manager.service';
import { PresenceService } from './presence/presence.service';
import { PresenceThrottler } from './presence/presence-throttler';
import { ReplayBufferService } from './projection/replay-buffer.service';
import { OutboxToWsSubscriber } from './projection/outbox-to-ws.subscriber';
import { MembershipRevocationListener } from './projection/membership-revocation.listener';
// PresenceService unused by the trimmed listener — re-import only if a new
// revocation path needs it.
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [
    RealtimeGateway,
    WsAuthMiddleware,
    RoomManagerService,
    PresenceService,
    PresenceThrottler,
    ReplayBufferService,
    OutboxToWsSubscriber,
    MembershipRevocationListener,
  ],
  exports: [RealtimeGateway, PresenceService],
})
export class RealtimeModule {}
