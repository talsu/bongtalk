import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ChannelsModule } from '../channels/channels.module';
import { OutboxModule } from '../common/outbox/outbox.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [WorkspacesModule, ChannelsModule, OutboxModule, AuthModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
