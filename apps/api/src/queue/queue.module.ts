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
// S88b (D ADR B4 / FR-MN-19 · FR-MN-03): @role 멘션 async fanout 큐.
import { MENTION_BROADCAST_QUEUE } from './mention-broadcast-queue.constants';
import { MentionBroadcastQueueService } from './mention-broadcast-queue.service';
import { MentionBroadcastProcessor } from './mention-broadcast.processor';
// S70 (D13 / FR-W12): 임시 멤버 disconnect debounce 강퇴 큐.
import { TEMP_EVICT_QUEUE } from './temp-evict-queue.constants';
import { TempEvictQueueService } from './temp-evict-queue.service';
import { TempEvictProcessor } from './temp-evict.processor';
// S71 (D13 / FR-W09): 워크스페이스 웰컴(시스템 DM + 입장 메시지) 비동기 발송 큐.
import { ONBOARDING_WELCOME_QUEUE } from './onboarding-welcome.constants';
import { OnboardingWelcomeQueueService } from './onboarding-welcome-queue.service';
import { OnboardingWelcomeProcessor } from './onboarding-welcome.processor';
// S86 (D16 / FR-MN-15): Web Push(VAPID) 전송 지연잡 큐(reminder 선례). PushProcessor 가
// PushService(전송 코어)를 주입하므로 PushModule 을 import 한다(단방향 — PushModule 은
// QueueModule 을 import 하지 않아 순환 없음). PushQueueService 는 @Global 로 OutboxToWs
// Subscriber 가 import 없이 주입한다.
import { PushModule } from '../push/push.module';
import { PUSH_SEND_QUEUE } from '../push/push-queue.constants';
import { PushQueueService } from '../push/push-queue.service';
import { PushProcessor } from '../push/push.processor';
// S88b (FR-MN-03 · FR-MN-19): MentionBroadcastProcessor 가 잡 시점 VIEW_CHANNEL 재검증에
// ChannelAccessService 를 주입한다. ChannelAccessService 의 의존(PrismaService · AuditService ·
// REDIS)은 전부 @Global 이라 무거운 ChannelsModule 을 import 하지 않고 이 서비스만 직접
// provider 로 등록한다(ChannelsModule ⇄ MessagesModule forwardRef 사이클 회피).
import { ChannelAccessService } from '../channels/permission/channel-access.service';
// S88b fix-forward (F1 / ★BLOCKER): MentionBroadcastProcessor 가 동기 send 경로와 동일한
// per-recipient 게이트(block/mute/DND/thread-OFF/NotifLevel)를 재적용하도록 공유
// MentionGateService 를 주입한다. MentionGateService 는 NotifLevelService 에 의존하고,
// 둘 다 @Global PrismaService 외 무거운 도메인 의존이 없어(NotifLevelService 는 Prisma 만,
// MentionGateService 는 Prisma + NotifLevelService) ChannelAccessService 와 동일하게
// NotificationsModule 을 import 하지 않고 두 서비스만 직접 provider 로 등록한다(AuthModule
// 경유 무거운 모듈 그래프·잠재 사이클 회피 — 기존 ChannelAccessService 직등록 선례).
import { NotifLevelService } from '../notifications/notif-level.service';
import { MentionGateService } from '../notifications/mention-gate.service';

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
    // S70 (FR-W12): 임시 멤버 disconnect debounce 강퇴 큐. forRootAsync 연결을 재사용한다.
    BullModule.registerQueue({ name: TEMP_EVICT_QUEUE }),
    // S71 (FR-W09): 워크스페이스 웰컴 발송 큐. forRootAsync 연결을 재사용한다.
    BullModule.registerQueue({ name: ONBOARDING_WELCOME_QUEUE }),
    // S86 (FR-MN-15): Web Push 전송 큐. forRootAsync 연결을 재사용한다.
    BullModule.registerQueue({ name: PUSH_SEND_QUEUE }),
    // S88b (FR-MN-19): @role 멘션 async fanout 큐. throughput 제한(100 jobs/s)은 worker
    // 측 limiter(@Processor 옵션 · MentionBroadcastProcessor)에서 적용한다 — RegisterQueue
    // Options 에는 limiter 필드가 없고, BullMQ 의 rate-limit 은 Worker 레벨 설정이다.
    BullModule.registerQueue({ name: MENTION_BROADCAST_QUEUE }),
    RealtimeModule,
    // S86: PushProcessor 가 PushService 를 주입한다(전송 코어 · 구독 GC). PushModule 은
    // QueueModule 을 import 하지 않으므로(단방향) 순환 없음. PrismaService 는 @Global.
    PushModule,
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
    // S70 (FR-W12): 임시 멤버 강퇴 큐 서비스 + worker. 서비스는 게이트웨이가 주입한다
    // (@Global 이라 import 없이 주입 가능 — ReminderQueueService 패턴). Processor 가
    // OutboxService(@Global) + PrismaService(@Global) + TempEvictQueueService 를 주입한다.
    TempEvictQueueService,
    TempEvictProcessor,
    // S71 (FR-W09): 웰컴 발송 큐 서비스(OnboardingService 가 @Global 주입) + worker. Processor 가
    // OutboxService(@Global) + PrismaService(@Global) 만 주입해 무거운 도메인 모듈을 끌어들이지 않는다.
    OnboardingWelcomeQueueService,
    OnboardingWelcomeProcessor,
    // S86 (FR-MN-15): Web Push 전송 큐 서비스(OutboxToWsSubscriber 가 @Global 주입) + worker.
    // Processor 가 PushService(PushModule) + PrismaService(@Global) 를 주입한다.
    PushQueueService,
    PushProcessor,
    // S88b (FR-MN-03 · FR-MN-19): @role 멘션 async fanout 큐 서비스(MessagesService 가 @Global
    // 주입) + worker. Processor 가 OutboxService(@Global) + PrismaService(@Global) +
    // ChannelAccessService + MentionGateService(아래 직접 등록) + MetricsService(@Optional)를
    // 주입한다. F1 fix-forward: 워커도 동기 경로와 동일 게이트를 거치도록 게이트 서비스 주입.
    ChannelAccessService,
    NotifLevelService,
    MentionGateService,
    MentionBroadcastQueueService,
    MentionBroadcastProcessor,
  ],
  exports: [
    ReminderQueueService,
    UnfurlQueueService,
    RoleCacheQueueService,
    TempEvictQueueService,
    OnboardingWelcomeQueueService,
    PushQueueService,
    MentionBroadcastQueueService,
  ],
})
export class QueueModule {}
