import { Module } from '@nestjs/common';
import { MutesController } from './mutes.controller';
import { MutesService } from './mutes.service';

/**
 * task-045 iter3: channel/DM mute module. PrismaModule 은 @Global,
 * Auth 도 APP_GUARD 로 글로벌 → import 불필요.
 */
@Module({
  controllers: [MutesController],
  providers: [MutesService],
  exports: [MutesService],
})
export class MutesModule {}
