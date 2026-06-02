import { Module } from '@nestjs/common';
import { MutesController } from './mutes.controller';
import { ServerMutesController } from './server-mutes.controller';
import { MutesService } from './mutes.service';

/**
 * task-045 iter3: channel/DM mute module. PrismaModule 은 @Global,
 * Auth 도 APP_GUARD 로 글로벌 → import 불필요.
 *
 * S49 (FR-MN-17): ServerMutesController(GET /me/server-mutes) 추가 — "현재 뮤트 중"
 * 서버 목록. 채널 목록은 기존 MutesController(GET /me/mutes)가 보강해 제공한다.
 */
@Module({
  controllers: [MutesController, ServerMutesController],
  providers: [MutesService],
  exports: [MutesService],
})
export class MutesModule {}
