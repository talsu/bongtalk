import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { HealthController } from './health/health.controller';
import { OutboxHealthIndicator } from './health/outbox-health.indicator';
import { RealtimeModule } from './realtime/realtime.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ChannelsModule } from './channels/channels.module';
import { MessagesModule } from './messages/messages.module';
import { MeModule } from './me/me.module';
import { FriendsModule } from './friends/friends.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { StorageModule } from './storage/storage.module';
import { ReactionsModule } from './reactions/reactions.module';
import { EmojisModule } from './emojis/emojis.module';
import { SlashCommandsModule } from './slash-commands/slash-commands.module';
import { SearchModule } from './search/search.module';
import { FeedbackModule } from './feedback/feedback.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { CommonModule } from './common/common.module';
import { AuditModule } from './common/audit/audit.module';
import { ObservabilityModule } from './observability/observability.module';
import { LinksModule } from './links/links.module';
import { MutesModule } from './notifications/mutes/mutes.module';
import { QueueModule } from './queue/queue.module';
// S86 (D16 / FR-MN-15): Web Push(VAPID) REST(공개키·구독 등록/해제) + 전송 코어.
import { PushModule } from './push/push.module';

@Module({
  imports: [
    // wildcard: true enables `@OnEvent('message.*')` etc. in task-005's
    // realtime projection. The existing channel/workspace emitters use
    // exact event names so flipping this on is additive.
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    // S34 (FR-TH-17): in-process cron 활성화. ThreadReplyCountReconciler 의
    // 1시간 주기 replyCount drift 재집계 @Cron 을 구동한다. 단일 NAS 배포라
    // 외부 스케줄러 없이 앱 프로세스 내 스케줄러를 쓴다.
    ScheduleModule.forRoot(),
    CommonModule,
    // S62 (D12 / FR-RM17): 감사 로그 서비스(@Global · append-only). PrismaModule
    // 뒤 어디서든 주입되며, channel-access 의 ADMINISTRATOR 우회 기록이 소비한다.
    AuditModule,
    ObservabilityModule,
    PrismaModule,
    RedisModule,
    OutboxModule,
    UsersModule,
    AuthModule,
    WorkspacesModule,
    ChannelsModule,
    MessagesModule,
    MeModule,
    FriendsModule,
    StorageModule,
    AttachmentsModule,
    ReactionsModule,
    EmojisModule,
    // S79 (D15 / FR-SC-01·02·03): 슬래시 커맨드 목록(빌트인 상수 + 워크스페이스 커스텀 병합).
    SlashCommandsModule,
    SearchModule,
    FeedbackModule,
    NotificationsModule,
    RealtimeModule,
    LinksModule,
    MutesModule,
    // S86 (D16 / FR-MN-15): Web Push(VAPID) — GET /push/vapid-public-key, POST/DELETE
    // /me/push/subscriptions, PushService(전송 코어). QueueModule 이 PushProcessor 를 위해
    // PushModule 을 import 하지만, REST 라우트 마운트를 위해 app 에도 명시 등록한다.
    PushModule,
    // S53 (D10 / FR-PS-09/10/11): 저장 리마인더 BullMQ in-process 큐 + worker.
    // @Global 이라 ReminderQueueService 가 앱 전역 주입(MessagesService/SavedService)
    // 된다. RealtimeModule 뒤에 둬 모듈 초기화 순서가 단방향(QueueModule→Realtime)이게.
    QueueModule,
  ],
  controllers: [HealthController],
  providers: [OutboxHealthIndicator, { provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
