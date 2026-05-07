import { Module } from '@nestjs/common';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';
import { AuthModule } from '../auth/auth.module';

/**
 * task-045 iter2: link preview module. RedisModule 은 @Global 이라 별도
 * import 불필요. AuthModule 은 JwtAuthGuard + RateLimitService 를 위해.
 */
@Module({
  imports: [AuthModule],
  controllers: [LinksController],
  providers: [LinksService],
  exports: [LinksService],
})
export class LinksModule {}
