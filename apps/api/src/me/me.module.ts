import { Module } from '@nestjs/common';
import { MeMentionsController } from './me-mentions.controller';
import { MeMentionsService } from './me-mentions.service';

@Module({
  controllers: [MeMentionsController],
  providers: [MeMentionsService],
  exports: [MeMentionsService],
})
export class MeModule {}
