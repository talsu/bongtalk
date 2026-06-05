import { Module } from '@nestjs/common';
import { SlashCommandController } from './slash-command.controller';
import { SlashCommandService } from './slash-command.service';
import { SlashExecutionController } from './slash-execution.controller';
import { SlashExecutionService } from './slash-execution.service';
import { ReminderController } from './reminder.controller';
import { ReminderService } from './reminder.service';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { ChannelsModule } from '../channels/channels.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MeModule } from '../me/me.module';

/**
 * S79 (D15 / FR-SC-01·02·03) — 슬래시 커맨드 모듈.
 * S80 (D15 / FR-SC-04·05·06 + FR-RC18) — 실행(execute) + /remind Reminder 합류.
 *
 * AuthModule 은 RateLimitService(목록·실행 게이트)와 JwtAuthGuard 를 제공한다.
 * PrismaModule·QueueModule(ReminderQueueService)·RedisModule(REDIS)은 @Global 이라 별도
 * import 없이 주입된다. S80 실행은 다음 도메인 서비스를 재사용한다:
 *   - MessagesModule.MessagesService  — IN_CHANNEL 텍스트 변환 후 채널 게시.
 *   - RealtimeModule.PresenceService + RealtimeGateway — /away·/active·/dnd presence 전환.
 *   - MeModule.CustomStatusService    — /status 커스텀 상태 설정.
 *   - ChannelsModule.ChannelAccessGuard/Service — execute 라우트(:chid)의 채널 접근 가드.
 *
 * ReminderService 는 OnModuleInit 에서 PENDING 리마인더를 BullMQ 에 재등록(bootstrap 복구)한다.
 *
 * 커스텀 CRUD(S81)·/giphy 실행(S81)은 본 슬라이스 OUT.
 */
@Module({
  imports: [AuthModule, MessagesModule, ChannelsModule, RealtimeModule, MeModule],
  controllers: [SlashCommandController, SlashExecutionController, ReminderController],
  providers: [SlashCommandService, SlashExecutionService, ReminderService],
  exports: [SlashCommandService, ReminderService],
})
export class SlashCommandsModule {}
