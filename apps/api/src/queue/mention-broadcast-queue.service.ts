import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MENTION_BROADCAST_QUEUE,
  MENTION_BROADCAST_JOB,
  MENTION_BROADCAST_OPTS,
  mentionBroadcastJobId,
  type MentionBroadcastJobData,
} from './mention-broadcast-queue.constants';

/**
 * S88b (ADR B2·B4 / FR-MN-19 · FR-MN-03): @role 멘션 async fanout 큐의 쓰기 facade.
 *
 * 메시지 전송 트랜잭션 커밋 후 fire-and-forget 으로 enqueue 한다(전송 tx 와 분리 —
 * Redis 일시 실패해도 메시지 전송에 영향 0). RealtimeModule 에 의존하지 않는다(WS/badge/
 * push 부수효과는 워커가 만든 mention.received outbox 를 기존 outbox-to-ws subscriber 가
 * 처리). QueueModule 이 @Global 이라 MessagesService 가 import 없이 주입할 수 있어
 * RealtimeGateway 와의 순환이 생기지 않는다(UnfurlQueueService 선례).
 *
 * 멱등 dedup: jobId = mentionBroadcastJobId(messageId). 같은 메시지에 두 번 enqueue 돼도
 * (재시도/경합) 기존 잡을 remove 후 재등록해 잡이 1개만 남는다. 잡 내부의 MentionRecord
 * ON CONFLICT DO NOTHING 이 처리 멱등의 최종 게이트라, jobId dedup 은 큐 적재만 줄인다.
 */
@Injectable()
export class MentionBroadcastQueueService {
  private readonly logger = new Logger(MentionBroadcastQueueService.name);

  constructor(
    @InjectQueue(MENTION_BROADCAST_QUEUE) private readonly queue: Queue<MentionBroadcastJobData>,
  ) {}

  /**
   * @role 멘션 fanout 잡을 큐에 넣는다. gatedRoleIds 가 비면 no-op(추가 RTT 없음).
   * best-effort — Redis 일시 실패는 throw 하지 않고 warn 만 남긴다(메시지 전송 영향 0 ·
   * 알림이 안 갈 뿐 · DB 메시지가 진실원). jobId=mention:{messageId} 로 멱등(remove→add).
   */
  async enqueue(data: MentionBroadcastJobData): Promise<void> {
    if (data.gatedRoleIds.length === 0) return;
    const jobId = mentionBroadcastJobId(data.messageId);
    try {
      await this.queue.remove(jobId).catch(() => undefined);
      await this.queue.add(MENTION_BROADCAST_JOB, data, { ...MENTION_BROADCAST_OPTS, jobId });
    } catch (err) {
      this.logger.warn(
        `[mention-broadcast] enqueue failed msg=${data.messageId} roles=${data.gatedRoleIds.length}: ${String(err).slice(0, 160)}`,
      );
    }
  }
}
