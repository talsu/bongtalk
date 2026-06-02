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
