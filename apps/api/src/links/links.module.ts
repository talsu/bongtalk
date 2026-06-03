import { Module } from '@nestjs/common';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';
import { OgImageFetcher } from './og-image-fetcher';
import { EmbedImageController } from './embed-image.controller';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { AttachmentsModule } from '../attachments/attachments.module';

/**
 * task-045 iter2: link preview module. RedisModule 은 @Global 이라 별도 import 불필요.
 * AuthModule 은 JwtAuthGuard + RateLimitService 를 위해.
 *
 * S60 (D11): unfurl OG 이미지 fetch(OgImageFetcher · StorageModule 의 S3Service) +
 * embed 이미지 프록시(EmbedImageController · AttachmentsModule 의 ChannelAccessByIdGuard).
 * LinksService / OgImageFetcher 를 export 해 QueueModule 의 UnfurlProcessor 가 주입한다.
 */
@Module({
  imports: [AuthModule, StorageModule, AttachmentsModule],
  controllers: [LinksController, EmbedImageController],
  providers: [LinksService, OgImageFetcher],
  exports: [LinksService, OgImageFetcher],
})
export class LinksModule {}
