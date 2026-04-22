import { Module } from '@nestjs/common';
import { MeMentionsController } from './me-mentions.controller';
import { MeMentionsService } from './me-mentions.service';
import { MeUnreadTotalsController } from './me-unread-totals.controller';
import { MePresenceController } from './me-presence.controller';
import { OnboardingController } from './onboarding.controller';
import { MeActivityController } from './me-activity.controller';
import { MeActivityService } from './me-activity.service';
import { ChannelsModule } from '../channels/channels.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ChannelsModule, RealtimeModule, AuthModule],
  controllers: [
    MeMentionsController,
    MeUnreadTotalsController,
    MePresenceController,
    OnboardingController,
    MeActivityController,
  ],
  providers: [MeMentionsService, MeActivityService],
  exports: [MeMentionsService, MeActivityService],
})
export class MeModule {}
