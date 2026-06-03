import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  REMINDER_QUEUE,
  REMINDER_FIRE_JOB,
  REMINDER_JOB_OPTS,
  type ReminderJobData,
} from './reminder-queue.constants';

/**
 * S53 (D10 / FR-PS-09/10): 저장 리마인더 큐의 쓰기 facade.
 *
 * BullMQ delayed job 만 다루며 RealtimeModule 에 의존하지 않는다(발화 emit 은
 * ReminderProcessor 가 담당). 이렇게 분리해 MessagesService / SavedService 가
 * 이 서비스를 inject 해도 RealtimeGateway 와의 순환이 생기지 않는다(QueueModule 이
 * @Global 이라 import 없이 주입 가능 — 모듈 그래프 간선 자체가 없음).
 *
 * 멱등 dedup: jobId = savedMessageId. schedule 은 기존 잡을 remove 후 add 하므로
 * 같은 저장 항목에 두 번 설정해도 잡이 1개만 남는다(중복 발화 방지). cancel 은
 * getJob 후 remove(없으면 no-op). reschedule(스누즈)은 schedule 과 동일 경로.
 */
@Injectable()
export class ReminderQueueService {
  private readonly logger = new Logger(ReminderQueueService.name);

  constructor(@InjectQueue(REMINDER_QUEUE) private readonly queue: Queue<ReminderJobData>) {}

  /**
   * 리마인더를 예약(또는 재예약)한다. jobId=savedMessageId 로 멱등 — 기존 잡을
   * 먼저 remove 한 뒤 새 delay 로 add 한다. delay 는 max(0, reminderAt-now)
   * 이라 과거 시각이면 즉시 발화 큐잉된다(놓친 예약 보정). add 자체는 Redis
   * 왕복이라 일시 실패해도 throw 하지 않고 warn 만 남긴다(PATCH 트랜잭션 커밋
   * 후 best-effort — DB reminderAt 이 진실원이고 worker 복구는 별도 후속 작업).
   */
  async schedule(args: {
    savedMessageId: string;
    userId: string;
    reminderAt: Date;
    now?: Date;
  }): Promise<void> {
    const now = args.now ?? new Date();
    const delay = Math.max(0, args.reminderAt.getTime() - now.getTime());
    try {
      // 기존 잡(있으면) 제거 후 동일 jobId 로 재등록 — BullMQ 는 같은 jobId 의
      // delayed 잡 재추가 시 무시(no-replace)하므로 명시 remove 가 필요하다.
      await this.queue.remove(args.savedMessageId).catch(() => undefined);
      await this.queue.add(
        REMINDER_FIRE_JOB,
        { savedMessageId: args.savedMessageId, userId: args.userId },
        { ...REMINDER_JOB_OPTS, jobId: args.savedMessageId, delay },
      );
    } catch (err) {
      this.logger.warn(
        `[reminder] schedule failed saved=${args.savedMessageId} delay=${delay}ms: ${String(err).slice(0, 160)}`,
      );
    }
  }

  /**
   * 예약된 리마인더를 취소한다(getJob 후 remove). 잡이 없으면 no-op. unsave /
   * status→COMPLETED / 원본 soft-delete cascade 에서 호출한다. best-effort —
   * 실패해도 throw 하지 않는다(DB 상태가 진실원).
   */
  async cancel(savedMessageId: string): Promise<void> {
    try {
      await this.queue.remove(savedMessageId);
    } catch (err) {
      this.logger.warn(
        `[reminder] cancel failed saved=${savedMessageId}: ${String(err).slice(0, 160)}`,
      );
    }
  }

  /**
   * 스누즈/시각 변경 재예약. schedule 과 동일 경로(remove→add)지만 호출 의도를
   * 명시하기 위한 별도 메서드다.
   */
  async reschedule(args: {
    savedMessageId: string;
    userId: string;
    reminderAt: Date;
    now?: Date;
  }): Promise<void> {
    await this.schedule(args);
  }
}
