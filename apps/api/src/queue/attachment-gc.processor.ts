import { Logger, type OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { AttachmentGcService } from '../attachments/attachment-gc.service';
import {
  ATTACHMENT_GC_QUEUE,
  ATTACHMENT_GC_JOB,
  ATTACHMENT_GC_JOB_ID,
  ATTACHMENT_GC_CRON,
  ATTACHMENT_GC_JOB_OPTS,
} from './attachment-gc.constants';

/**
 * S55 (D11 / FR-AM-29): 첨부 orphan GC worker(BullMQ repeatable).
 *
 * onModuleInit 에서 cron(매일 04:00 UTC) repeatable 잡을 고정 jobId 로 등록한다 —
 * BullMQ 는 동일 repeat 옵션의 재등록을 dedup 하므로 매 부팅마다 호출돼도 단일
 * 스케줄만 남는다(멱등). 실제 sweep 로직은 AttachmentGcService.sweep() 에 위임한다
 * (큐 인프라 ↔ 도메인 분리 — int/unit 은 서비스를 직접 호출).
 *
 * WorkerHost lifecycle 은 @nestjs/bullmq 가 관리한다(graceful shutdown 자동).
 * repeatable 메타는 Redis 에 영속하므로 재시작 후에도 다음 cron 시각에 발화한다.
 */
@Processor(ATTACHMENT_GC_QUEUE)
export class AttachmentGcProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AttachmentGcProcessor.name);

  constructor(
    @InjectQueue(ATTACHMENT_GC_QUEUE) private readonly queue: Queue,
    private readonly gc: AttachmentGcService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        ATTACHMENT_GC_JOB,
        {},
        {
          ...ATTACHMENT_GC_JOB_OPTS,
          jobId: ATTACHMENT_GC_JOB_ID,
          repeat: { pattern: ATTACHMENT_GC_CRON },
        },
      );
      this.logger.log(`[attachment-gc] repeatable scheduled cron='${ATTACHMENT_GC_CRON}'`);
    } catch (err) {
      // Redis 미준비/일시 실패는 throw 하지 않는다(부팅을 막지 않음 — 다음 부팅에서
      // 재등록). 발화 누락은 best-effort GC 라 user-visible 영향이 없다.
      this.logger.warn(`[attachment-gc] schedule failed: ${String(err).slice(0, 160)}`);
    }
  }

  async process(_job: Job): Promise<void> {
    await this.gc.sweep(new Date());
  }
}
