import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import IORedis from 'ioredis';
import { RealtimeModule } from '../realtime/realtime.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { LinksModule } from '../links/links.module';
import { REMINDER_QUEUE } from './reminder-queue.constants';
import { ReminderQueueService } from './reminder-queue.service';
import { ReminderProcessor } from './reminder.processor';
import { ATTACHMENT_GC_QUEUE } from './attachment-gc.constants';
import { AttachmentGcProcessor } from './attachment-gc.processor';
import { UNFURL_QUEUE } from './unfurl-queue.constants';
import { UnfurlQueueService } from './unfurl-queue.service';
import { UnfurlProcessor } from './unfurl.processor';
import { ROLE_CACHE_QUEUE } from './role-cache-queue.constants';
import { RoleCacheQueueService } from './role-cache-queue.service';
import { RoleCacheProcessor } from './role-cache.processor';

/**
 * S53 (D10 / FR-PS-09/10/11): BullMQ in-process 통합 모듈.
 *
 * ★별도 Redis 연결: BullMQ 의 Worker 는 BRPOPLPUSH 등 blocking 명령을 쓰므로
 * ioredis 의 maxRetriesPerRequest 가 null 이어야 한다(기본 3 이면 blocking 중
 * 명령이 조기 reject 됨 — BullMQ 가 명시적으로 요구). 기존 공유 RedisModule 의
 * 클라이언트는 maxRetriesPerRequest:3 + keyPrefix:'qufox:' 라 그대로 쓸 수 없다.
 * 그래서 같은 REDIS_URL 로 BullMQ 전용 IORedis 연결을 새로 만든다
 * (maxRetriesPerRequest:null · enableReadyCheck:false). io-adapter 가 pub/sub
 * 용으로 base.duplicate 를 쓰는 것과 같은 "전용 연결" 패턴이다.
 *
 * ★순환 의존: 이 모듈은 @Global 이라 ReminderQueueService 가 import 없이 앱 전역에
 * 주입된다 — MessagesService / SavedService 가 이 서비스를 쓰면서도 QueueModule 을
 * import 하지 않으므로(모듈 그래프 간선 없음) RealtimeModule → MessagesModule 과의
 * 순환이 생기지 않는다. 이 모듈만 단방향으로 RealtimeModule 을 import 한다
 * (ReminderProcessor 가 RealtimeGateway 로 emit). 그래프: QueueModule →
 * RealtimeModule → MessagesModule (단방향, 무순환).
 *
 * graceful shutdown: WorkerHost(@nestjs/bullmq)가 onModuleDestroy 에서 worker 를
 * 닫는다. 미발화 delayed job 은 Redis 에 영속하므로 재시작 후 복구된다(단일 노드).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          // BullMQ blocking 명령 호환 — 필수.
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        }),
      }),
    }),
    BullModule.registerQueue({ name: REMINDER_QUEUE }),
    // S55 (FR-AM-29): orphan GC repeatable 큐. forRootAsync 연결을 재사용한다.
    BullModule.registerQueue({ name: ATTACHMENT_GC_QUEUE }),
    // S60 (FR-AM-13 · FR-RC07): 링크 unfurl 큐. forRootAsync 연결을 재사용한다.
    BullModule.registerQueue({ name: UNFURL_QUEUE }),
    // S61 (FR-RM15): 역할 삭제 cascade 권한 캐시 무효화 배치 큐(>1000명).
    BullModule.registerQueue({ name: ROLE_CACHE_QUEUE }),
    RealtimeModule,
    // S55: AttachmentGcProcessor 가 AttachmentGcService 를 주입한다. AttachmentsModule
    // 은 QueueModule 을 import 하지 않으므로(단방향) 순환 없음. ChannelsModule 은 이미
    // RealtimeModule 경유로 그래프에 있어 신규 간선이 추가하는 사이클이 없다.
    AttachmentsModule,
    // S60: UnfurlProcessor 가 LinksService(fetch+캐시) + OgImageFetcher(MinIO)를 주입한다.
    // LinksModule 은 QueueModule 을 import 하지 않으므로(단방향) 순환 없음. OutboxService 는
    // @Global 이라 import 없이 주입되며, PrismaService 도 @Global 이다.
    LinksModule,
  ],
  providers: [
    ReminderQueueService,
    ReminderProcessor,
    AttachmentGcProcessor,
    UnfurlQueueService,
    UnfurlProcessor,
    RoleCacheQueueService,
    RoleCacheProcessor,
  ],
  exports: [ReminderQueueService, UnfurlQueueService, RoleCacheQueueService],
})
export class QueueModule {}
