import { Module } from '@nestjs/common';
import { CustomEmojiController } from './custom-emoji.controller';
import { CustomEmojiService } from './custom-emoji.service';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';

/**
 * task-037-D: workspace custom-emoji module. AuthModule is imported for
 * RateLimitService; StorageModule provides the S3Service used for the
 * presigned PUT/GET calls and the delete on teardown.
 */
@Module({
  imports: [StorageModule, AuthModule],
  controllers: [CustomEmojiController],
  providers: [CustomEmojiService],
  exports: [CustomEmojiService],
})
export class EmojisModule {}
