import { Module } from '@nestjs/common';
import { MeMentionsController } from './me-mentions.controller';
import { MeMentionsService } from './me-mentions.service';
import { MeUnreadTotalsController } from './me-unread-totals.controller';
import { OnboardingController } from './onboarding.controller';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  imports: [ChannelsModule],
  controllers: [MeMentionsController, MeUnreadTotalsController, OnboardingController],
  providers: [MeMentionsService],
  exports: [MeMentionsService],
})
export class MeModule {}
