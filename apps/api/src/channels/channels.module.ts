import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ChannelReadController, UnreadSummaryController } from './unread.controller';
import { UnreadService } from './unread.service';
import { ChannelAccessService } from './permission/channel-access.service';
import { ChannelAccessGuard } from './guards/channel-access.guard';
import { DirectMessagesController } from './direct-messages/direct-messages.controller';
import { DirectMessagesService } from './direct-messages/direct-messages.service';
import { GlobalDmController } from './direct-messages/global-dm.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { OutboxModule } from '../common/outbox/outbox.module';

@Module({
  imports: [WorkspacesModule, OutboxModule],
  controllers: [
    ChannelsController,
    CategoriesController,
    UnreadSummaryController,
    ChannelReadController,
    DirectMessagesController,
    GlobalDmController,
  ],
  // Task-014-A: ChannelAccessService is the single source of truth for
  // channel ACL checks (private-channel visibility, permission-bit
  // gating). Both ChannelAccessGuard (URL-path) and ChannelAccessByIdGuard
  // (body-param) now consume it; export so downstream modules like
  // attachments / reactions / threads can wire the by-id guard.
  providers: [
    ChannelsService,
    CategoriesService,
    UnreadService,
    ChannelAccessService,
    ChannelAccessGuard,
    DirectMessagesService,
  ],
  exports: [
    ChannelsService,
    CategoriesService,
    UnreadService,
    ChannelAccessService,
    ChannelAccessGuard,
    DirectMessagesService,
  ],
})
export class ChannelsModule {}
