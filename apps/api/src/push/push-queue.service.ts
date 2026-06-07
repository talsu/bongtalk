import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PUSH_SEND_QUEUE,
  PUSH_SEND_JOB,
  PUSH_SEND_JOB_OPTS,
  type PushSendJobData,
} from './push-queue.constants';

/**
 * S86 (D16 / FR-MN-15): push-send 큐의 쓰기 facade(ReminderQueueService 선례).
 *
 * BullMQ delayed job 만 다루며 RealtimeModule/PrismaService 에 직접 의존하지 않는다
 * (전송·재게이트는 PushProcessor 가 담당). @Global QueueModule 이라 OutboxToWsSubscriber 가
 * import 없이 주입할 수 있다(모듈 그래프 간선 없음 — 순환 회피).
 *
 * 데스크톱 세션 활성(presence lastSeen < 5분)이면 delayMs=60000(60초) 후 실행해, 그
 * 사이 사용자가 읽으면 잡 실행 시점 read-check 가 전송을 건너뛴다(중복/불필요 푸시 억제).
 * 비활성이면 delayMs=0(즉시). add 실패는 throw 하지 않고 warn 만 남긴다(멘션 WS emit 은
 * 이미 끝났으므로 best-effort — DB 가 진실원이고 푸시는 부가 채널).
 */
@Injectable()
export class PushQueueService {
  private readonly logger = new Logger(PushQueueService.name);

  constructor(@InjectQueue(PUSH_SEND_QUEUE) private readonly queue: Queue<PushSendJobData>) {}

  async enqueue(data: PushSendJobData, delayMs: number): Promise<void> {
    const delay = Math.max(0, delayMs);
    try {
      await this.queue.add(PUSH_SEND_JOB, data, { ...PUSH_SEND_JOB_OPTS, delay });
    } catch (err) {
      this.logger.warn(
        `[push] enqueue failed user=${data.userId} ch=${data.channelId} delay=${delay}ms: ${String(err).slice(0, 160)}`,
      );
    }
  }
}
