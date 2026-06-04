import { Module } from '@nestjs/common';
import { MeMentionsController } from './me-mentions.controller';
import { MeMentionsService } from './me-mentions.service';
import { MeUnreadTotalsController } from './me-unread-totals.controller';
import { MePresenceController } from './me-presence.controller';
import { MeStatusController } from './me-status.controller';
import { OnboardingController } from './onboarding.controller';
import { MeActivityController } from './me-activity.controller';
import { MeActivityService } from './me-activity.service';
// S47 (D06 / FR-MN-14/20): 서버 단위 알림 배지(isMuted 제외) 집계 + 재동기화 엔드포인트.
import { MeNotificationBadgesController } from './me-notification-badges.controller';
import { MeNotificationBadgesModule } from './me-notification-badges.module';
import { ChannelsModule } from '../channels/channels.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';
import { StatusBroadcastThrottler } from './status-broadcast-throttler';
import { DndScheduleController } from './dnd-schedule.controller';
import { DndScheduleService } from './dnd-schedule.service';
import { CustomStatusController } from './custom-status.controller';
import { CustomStatusService } from './custom-status.service';
import { NotificationOnboardingController } from './notification-onboarding.controller';
import { MeProfileController } from './me-profile.controller';
// S73 (D14 / FR-PS-01·02·03): 전역 프로필 + 아바타. ProfileService 가 도메인 규칙을
// 보유하고, 아바타는 StorageModule 의 S3Service(presignPut/headObject/magic-byte)를 쓴다.
import { MeAvatarController } from './me-avatar.controller';
// S74 (D14 / FR-PS-04): 전역 프로필 배너. ProfileService(아바타와 동일 패턴) + StorageModule.
import { MeBannerController } from './me-banner.controller';
import { ProfileService } from './profile.service';
import { StorageModule } from '../storage/storage.module';
// S11 (FR-RT-13): POST /workspaces/:id/channels/:chid/ack. RealtimeGateway +
// UnreadService 둘 다 필요하므로 두 모듈을 모두 import 하는 MeModule 에 둔다.
import { ChannelAckController } from './channel-ack.controller';

// S23 (FR-RS-11): POST /workspaces/:id/read-all (Shift+Esc 전체 읽음).
// ChannelAckController 와 동일하게 RealtimeGateway + UnreadService 를 쓴다.
import { WorkspaceReadAllController } from './workspace-read-all.controller';

// S51 (D10 / FR-PS-07): 개인 저장함(`/me/saved`). JWT 만 거치는 개인 전용 라우트.
import { SavedController } from './saved/saved.controller';
import { SavedService } from './saved/saved.service';

// task-045 iter7: MeStatusController 가 RealtimeGateway 를 inject 하므로
// RealtimeModule 이 이미 imports 에 있어야 함 — 그대로 OK.
// task-046 iter0: StatusBroadcastThrottler (MED-1 carry-over).
// task-046 iter4: DndSchedule (K1) + NotificationOnboarding (K4).
@Module({
  imports: [ChannelsModule, RealtimeModule, AuthModule, MeNotificationBadgesModule, StorageModule],
  controllers: [
    MeMentionsController,
    MeUnreadTotalsController,
    MePresenceController,
    MeStatusController,
    CustomStatusController,
    OnboardingController,
    MeActivityController,
    MeNotificationBadgesController,
    DndScheduleController,
    NotificationOnboardingController,
    MeProfileController,
    MeAvatarController,
    MeBannerController,
    ChannelAckController,
    WorkspaceReadAllController,
    SavedController,
  ],
  providers: [
    MeMentionsService,
    MeActivityService,
    StatusBroadcastThrottler,
    DndScheduleService,
    CustomStatusService,
    SavedService,
    ProfileService,
  ],
  exports: [MeMentionsService, MeActivityService, DndScheduleService, CustomStatusService],
})
export class MeModule {}
