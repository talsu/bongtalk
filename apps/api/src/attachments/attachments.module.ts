import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  // task-014-A: ChannelsModule exports the shared ChannelAccessService
  // that ChannelAccessByIdGuard now delegates to.
  imports: [StorageModule, ChannelsModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, ChannelAccessByIdGuard],
  exports: [AttachmentsService, ChannelAccessByIdGuard],
})
export class AttachmentsModule {}
