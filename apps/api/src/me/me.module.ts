import { Module } from '@nestjs/common';
import { MeMentionsController } from './me-mentions.controller';
import { MeMentionsService } from './me-mentions.service';
import { MeUnreadTotalsController } from './me-unread-totals.controller';
import { MePresenceController } from './me-presence.controller';
import { MeStatusController } from './me-status.controller';
import { OnboardingController } from './onboarding.controller';
import { MeActivityController } from './me-activity.controller';
import { MeActivityService } from './me-activity.service';
import { ChannelsModule } from '../channels/channels.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';
import { StatusBroadcastThrottler } from './status-broadcast-throttler';
import { DndScheduleController } from './dnd-schedule.controller';
import { DndScheduleService } from './dnd-schedule.service';
import { NotificationOnboardingController } from './notification-onboarding.controller';

// task-045 iter7: MeStatusController 가 RealtimeGateway 를 inject 하므로
// RealtimeModule 이 이미 imports 에 있어야 함 — 그대로 OK.
// task-046 iter0: StatusBroadcastThrottler (MED-1 carry-over).
// task-046 iter4: DndSchedule (K1) + NotificationOnboarding (K4).
@Module({
  imports: [ChannelsModule, RealtimeModule, AuthModule],
  controllers: [
    MeMentionsController,
    MeUnreadTotalsController,
    MePresenceController,
    MeStatusController,
    OnboardingController,
    MeActivityController,
    DndScheduleController,
    NotificationOnboardingController,
  ],
  providers: [MeMentionsService, MeActivityService, StatusBroadcastThrottler, DndScheduleService],
  exports: [MeMentionsService, MeActivityService, DndScheduleService],
})
export class MeModule {}
