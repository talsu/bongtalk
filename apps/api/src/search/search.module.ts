import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AuthModule } from '../auth/auth.module';

// task-016-B (015-follow-2): SearchService no longer imports
// ChannelAccessService — the visibleChannelIds loop was folded into
// two batched queries that call PermissionMatrix directly. Drops
// the ChannelsModule import along with it.
@Module({
  imports: [AuthModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
