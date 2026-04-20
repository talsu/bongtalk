import { Module } from '@nestjs/common';
import { MeMentionsController } from './me-mentions.controller';
import { MeMentionsService } from './me-mentions.service';
import { OnboardingController } from './onboarding.controller';

@Module({
  controllers: [MeMentionsController, OnboardingController],
  providers: [MeMentionsService],
  exports: [MeMentionsService],
})
export class MeModule {}
