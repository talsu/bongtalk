import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { ThreadsController } from './threads.controller';
import { GlobalDmMessagesController } from './global-dm-messages.controller';
import { DmChannelAccessGuard } from './guards/dm-channel-access.guard';
import { ThreadSubscriptionsService } from './thread-subscriptions.service';
import { ThreadSubscriptionsController } from './thread-subscriptions.controller';
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
  imports: [WorkspacesModule, ChannelsModule, OutboxModule, AuthModule, AttachmentsModule],
  controllers: [
    MessagesController,
    ThreadsController,
    GlobalDmMessagesController,
    ThreadSubscriptionsController,
  ],
  providers: [MessagesService, DmChannelAccessGuard, ThreadSubscriptionsService],
  exports: [MessagesService, ThreadSubscriptionsService],
})
export class MessagesModule {}
