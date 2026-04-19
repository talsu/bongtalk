import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { OutboxModule } from '../common/outbox/outbox.module';

@Module({
  imports: [WorkspacesModule, OutboxModule],
  controllers: [ChannelsController, CategoriesController],
  providers: [ChannelsService, CategoriesService],
  exports: [ChannelsService, CategoriesService],
})
export class ChannelsModule {}
