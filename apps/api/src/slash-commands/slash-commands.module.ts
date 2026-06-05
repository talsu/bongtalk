import { Module } from '@nestjs/common';
import { SlashCommandController } from './slash-command.controller';
import { SlashCommandService } from './slash-command.service';
import { CustomSlashCommandController } from './custom-slash-command.controller';
import { CustomSlashCommandService } from './custom-slash-command.service';
import { SlashExecutionController } from './slash-execution.controller';
import { SlashExecutionService } from './slash-execution.service';
import { ReminderController } from './reminder.controller';
import { ReminderService } from './reminder.service';
import { GiphyController } from './giphy.controller';
import {
  GiphyProxyService,
  GIPHY_FETCH,
  GIPHY_KEY_PROVIDER,
  type GiphyFetch,
  type GiphyKeyProvider,
} from './giphy-proxy.service';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { ChannelsModule } from '../channels/channels.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MeModule } from '../me/me.module';
// S81a (FR-SC-08): /nick·/kick 서버 커맨드가 WorkspaceMemberProfileService·ModerationService 를,
// /mute 가 MutesService 를 재사용한다. ChannelsModule(이미 import)이 ChannelsService·
// ChannelAccessService·DirectMessagesService(/topic·/invite·/msg)를 제공한다.
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MutesModule } from '../notifications/mutes/mutes.module';

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
  imports: [
    AuthModule,
    MessagesModule,
    ChannelsModule,
    RealtimeModule,
    MeModule,
    WorkspacesModule,
    MutesModule,
  ],
  controllers: [
    SlashCommandController,
    // S81c (FR-SC-09·10): 커스텀 슬래시 커맨드 CRUD(ADMIN 전용). GET 목록은 SlashCommandController.
    CustomSlashCommandController,
    SlashExecutionController,
    ReminderController,
    // S81b (FR-SC-07): GIPHY 검색 프록시(프리뷰 Shuffle).
    GiphyController,
  ],
  providers: [
    SlashCommandService,
    CustomSlashCommandService,
    SlashExecutionService,
    ReminderService,
    GiphyProxyService,
    // S81b (FR-SC-07): GiphyProxyService 의 HTTP 경계 + 키 공급자를 명시적으로 제공한다.
    // 고정 호스트(api.giphy.com)라 SSRF 무관 — global fetch 를 그대로 어댑트한다(테스트는
    // GiphyProxyService 생성자에 vi.fn() 을 직접 주입해 이 토큰을 우회한다).
    {
      provide: GIPHY_FETCH,
      useValue: ((url, init) =>
        fetch(url, init).then((r) => ({
          ok: r.ok,
          status: r.status,
          json: () => r.json(),
        }))) satisfies GiphyFetch,
    },
    {
      provide: GIPHY_KEY_PROVIDER,
      useValue: (() => process.env.GIPHY_API_KEY) satisfies GiphyKeyProvider,
    },
  ],
  exports: [SlashCommandService, ReminderService],
})
export class SlashCommandsModule {}
