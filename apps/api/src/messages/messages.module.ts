import { forwardRef, Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { ThreadsController } from './threads.controller';
import { GlobalDmMessagesController } from './global-dm-messages.controller';
import { DmChannelAccessGuard } from './guards/dm-channel-access.guard';
import { ThreadSubscriptionsService } from './thread-subscriptions.service';
import { ThreadSubscriptionsController } from './thread-subscriptions.controller';
import { ThreadReplyCountReconciler } from './thread-reply-count-reconciler.service';
import { ThreadReadStateService } from './thread-read-state.service';
import { MyThreadsService } from './my-threads.service';
import { MeThreadsController } from './me-threads.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ChannelsModule } from '../channels/channels.module';
import { OutboxModule } from '../common/outbox/outbox.module';
import { AuthModule } from '../auth/auth.module';
import { AttachmentsModule } from '../attachments/attachments.module';
// S41 (FR-EM06 / FR-RC20): 반응 집계가 커스텀 이모지 storageKey 를 presigned url
// 로 변환하려면 S3Service 가 필요하다(StorageModule 제공).
import { StorageModule } from '../storage/storage.module';
// S44 (FR-MN-02): `@here` fanout 을 presence ONLINE/IDLE 멤버로 한정하려면
// PresenceService 가 필요하다. PresenceModule 은 REDIS 만 의존해 순환이 없다.
import { PresenceModule } from '../realtime/presence/presence.module';
// S46 (D06 / FR-MN-05/06/07/08): 멘션 fanout 의 NotifLevel 3계층 게이트.
// NotificationsModule 이 NotifLevelService 를 export 하며, NotificationsModule 은
// 어떤 도메인 모듈도 import 하지 않아 순환이 없다.
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // task-014-B: AttachmentsModule exports ChannelAccessByIdGuard which
  // the thread-replies endpoint uses to gate the READ permission
  // (symmetric with reactions).
  // task-046 iter6: ThreadSubscriptions (N1/N2/N3).
  // S13 (FR-CH-09/04): ChannelsService 가 MessagesService.createSystemMessage 를
  // 역참조하므로 ChannelsModule ↔ MessagesModule 순환을 forwardRef 로 끊는다.
  imports: [
    WorkspacesModule,
    forwardRef(() => ChannelsModule),
    OutboxModule,
    AuthModule,
    AttachmentsModule,
    StorageModule,
    PresenceModule,
    NotificationsModule,
  ],
  controllers: [
    MessagesController,
    ThreadsController,
    GlobalDmMessagesController,
    ThreadSubscriptionsController,
    // S38 (FR-TH-08/09/10): 사용자 스코프 Threads 탭 + 알림 레벨.
    MeThreadsController,
  ],
  providers: [
    MessagesService,
    DmChannelAccessGuard,
    ThreadSubscriptionsService,
    // S34 (FR-TH-17): 1시간 주기 replyCount drift 재집계 cron provider.
    ThreadReplyCountReconciler,
    // S36 (FR-RS-12 / FR-TH-04/11/12): 스레드 읽음 커서 코어.
    ThreadReadStateService,
    // S38 (FR-TH-09/10): Threads 탭 목록 + 전체 읽음.
    MyThreadsService,
  ],
  exports: [MessagesService, ThreadSubscriptionsService, ThreadReadStateService],
})
export class MessagesModule {}
