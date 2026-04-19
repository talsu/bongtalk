import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, ChannelAccessByIdGuard],
  exports: [AttachmentsService, ChannelAccessByIdGuard],
})
export class AttachmentsModule {}
