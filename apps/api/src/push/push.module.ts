import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/**
 * S86 (D16 / FR-MN-15): Web Push(VAPID) 도메인 모듈.
 *
 * PushService(전송 코어 · setVapidDetails · 구독 upsert/GC)와 REST 컨트롤러를 보유한다.
 * PushQueueService / PushProcessor 는 @Global QueueModule 에 등록한다(BullMQ 연결 공유 +
 * OutboxToWsSubscriber 가 import 없이 PushQueueService 를 주입 — reminder 큐 선례). 그래서
 * QueueModule 이 PushModule 을 import 해 PushProcessor 가 PushService 를 주입받게 하고,
 * 본 모듈은 PushService 를 export 한다(PrismaService 는 @Global).
 */
@Module({
  imports: [AuthModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
