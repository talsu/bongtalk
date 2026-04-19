import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ChannelReadController, UnreadSummaryController } from './unread.controller';
import { UnreadService } from './unread.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { OutboxModule } from '../common/outbox/outbox.module';

@Module({
  imports: [WorkspacesModule, OutboxModule],
  controllers: [
    ChannelsController,
    CategoriesController,
    UnreadSummaryController,
    ChannelReadController,
  ],
  providers: [ChannelsService, CategoriesService, UnreadService],
  exports: [ChannelsService, CategoriesService, UnreadService],
})
export class ChannelsModule {}
