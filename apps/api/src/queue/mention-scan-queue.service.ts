import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MENTION_SCAN_QUEUE,
  MENTION_SCAN_JOB,
  MENTION_SCAN_OPTS,
  mentionScanJobId,
  type MentionScanJobData,
} from './mention-scan-queue.constants';

/**
 * FR-MN-10 (Task 066 / S93): 키워드 알림 스캔 async 큐의 쓰기 facade(mention-broadcast 미러).
 *
 * 메시지 전송 트랜잭션 커밋 후 fire-and-forget 으로 enqueue 한다(전송 tx 와 분리 — Redis
 * 일시 실패해도 메시지 전송에 영향 0). RealtimeModule 에 의존하지 않는다(WS/badge/push
 * 부수효과는 워커가 만든 mention.received outbox 를 기존 outbox-to-ws subscriber 가 처리).
 * QueueModule 이 @Global 이라 MessagesService 가 import 없이 주입할 수 있어 RealtimeGateway
 * 와의 순환이 생기지 않는다(MentionBroadcastQueueService 선례).
 *
 * 멱등 dedup: jobId = mentionScanJobId(messageId). 같은 메시지에 두 번 enqueue 돼도
 * (재시도/경합) 기존 잡을 remove 후 재등록해 잡이 1개만 남는다. 잡 내부의 MentionRecord
 * ON CONFLICT DO NOTHING 이 처리 멱등의 최종 게이트라, jobId dedup 은 큐 적재만 줄인다.
 */
@Injectable()
export class MentionScanQueueService {
  private readonly logger = new Logger(MentionScanQueueService.name);

  constructor(@InjectQueue(MENTION_SCAN_QUEUE) private readonly queue: Queue<MentionScanJobData>) {}

  /**
   * 키워드 스캔 잡을 큐에 넣는다. best-effort — Redis 일시 실패는 throw 하지 않고 warn 만
   * 남긴다(메시지 전송 영향 0 · 키워드 알림이 안 갈 뿐 · DB 메시지가 진실원). jobId=
   * mention-scan:{messageId} 로 멱등(remove→add). 워커가 watcher 0명이면 (2) 쿼리에서
   * early-exit 하므로, 키워드 보유자가 없는 워크스페이스도 잡 적재만 1건 늘 뿐 비용이 작다.
   */
  async enqueue(data: MentionScanJobData): Promise<void> {
    const jobId = mentionScanJobId(data.messageId);
    try {
      await this.queue.remove(jobId).catch(() => undefined);
      await this.queue.add(MENTION_SCAN_JOB, data, { ...MENTION_SCAN_OPTS, jobId });
    } catch (err) {
      this.logger.warn(
        `[mention-scan] enqueue failed msg=${data.messageId}: ${String(err).slice(0, 160)}`,
      );
    }
  }
}
