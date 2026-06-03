import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  UNFURL_QUEUE,
  UNFURL_JOB,
  UNFURL_JOB_OPTS,
  type UnfurlJobData,
} from './unfurl-queue.constants';

/**
 * S60 (D11 / FR-AM-13 · FR-RC07): 링크 unfurl 큐의 쓰기 facade.
 *
 * 메시지 send/edit 완료 후 fire-and-forget 으로 enqueue 한다(전송 트랜잭션과 분리 —
 * Redis 일시 실패해도 메시지 전송에 영향 0). RealtimeModule 에 의존하지 않는다(emit 은
 * UnfurlProcessor 담당). QueueModule 이 @Global 이라 MessagesService 가 import 없이
 * 주입할 수 있어 RealtimeGateway 와의 순환이 생기지 않는다(ReminderQueueService 선례).
 *
 * 멱등 dedup: jobId = messageId. 같은 메시지에 두 번 enqueue 돼도(edit 재전송 등) 기존
 * 잡을 remove 후 재등록해 잡이 1개만 남는다.
 */
@Injectable()
export class UnfurlQueueService {
  private readonly logger = new Logger(UnfurlQueueService.name);

  constructor(@InjectQueue(UNFURL_QUEUE) private readonly queue: Queue<UnfurlJobData>) {}

  /**
   * 메시지의 URL 목록을 unfurl 큐에 넣는다. urls 가 비면 no-op(추가 RTT 없음).
   * best-effort — Redis 일시 실패는 throw 하지 않고 warn 만 남긴다(메시지 전송 영향 0 ·
   * 카드가 안 뜰 뿐). jobId=messageId 로 멱등(remove→add).
   */
  async enqueue(data: UnfurlJobData): Promise<void> {
    if (data.urls.length === 0) return;
    try {
      await this.queue.remove(data.messageId).catch(() => undefined);
      await this.queue.add(UNFURL_JOB, data, { ...UNFURL_JOB_OPTS, jobId: data.messageId });
    } catch (err) {
      this.logger.warn(
        `[unfurl] enqueue failed msg=${data.messageId} urls=${data.urls.length}: ${String(err).slice(0, 160)}`,
      );
    }
  }
}
