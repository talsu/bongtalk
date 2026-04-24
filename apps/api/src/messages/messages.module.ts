import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { ThreadsController } from './threads.controller';
import { GlobalDmMessagesController } from './global-dm-messages.controller';
import { DmChannelAccessGuard } from './guards/dm-channel-access.guard';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ChannelsModule } from '../channels/channels.module';
import { OutboxModule } from '../common/outbox/outbox.module';
import { AuthModule } from '../auth/auth.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  // task-014-B: AttachmentsModule exports ChannelAccessByIdGuard which
  // the thread-replies endpoint uses to gate the READ permission
  // (symmetric with reactions).
  imports: [WorkspacesModule, ChannelsModule, OutboxModule, AuthModule, AttachmentsModule],
  controllers: [MessagesController, ThreadsController, GlobalDmMessagesController],
  providers: [MessagesService, DmChannelAccessGuard],
  exports: [MessagesService],
})
export class MessagesModule {}
