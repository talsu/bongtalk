import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ONBOARDING_WELCOME_QUEUE,
  ONBOARDING_WELCOME_JOB,
  ONBOARDING_WELCOME_JOB_OPTS,
  onboardingWelcomeJobId,
  type OnboardingWelcomeJobData,
} from './onboarding-welcome.constants';

/**
 * S71 (D13 / FR-W09): 웰컴 발송 큐의 쓰기 facade.
 *
 * OnboardingService.complete 트랜잭션이 커밋된 뒤 enqueue 한다(시스템 DM·입장 메시지는
 * tx 와 분리 — 결정사항). RealtimeModule 에 의존하지 않으므로 OnboardingService 가 이
 * 서비스를 inject 해도 순환이 생기지 않는다(QueueModule 이 @Global). best-effort —
 * enqueue 실패는 warn 만 남기고 throw 하지 않는다(complete 자체는 이미 커밋됨).
 */
@Injectable()
export class OnboardingWelcomeQueueService {
  private readonly logger = new Logger(OnboardingWelcomeQueueService.name);

  constructor(
    @InjectQueue(ONBOARDING_WELCOME_QUEUE)
    private readonly queue: Queue<OnboardingWelcomeJobData>,
  ) {}

  async enqueue(workspaceId: string, userId: string): Promise<void> {
    const jobId = onboardingWelcomeJobId(workspaceId, userId);
    try {
      // 멱등 complete 재호출이 중복 잡을 만들지 않도록 기존 잡(있으면) 제거 후 재등록.
      await this.queue.remove(jobId).catch(() => undefined);
      await this.queue.add(
        ONBOARDING_WELCOME_JOB,
        { workspaceId, userId },
        { ...ONBOARDING_WELCOME_JOB_OPTS, jobId },
      );
    } catch (err) {
      this.logger.warn(
        `[onboarding-welcome] enqueue failed ws=${workspaceId} user=${userId}: ${String(err).slice(0, 160)}`,
      );
    }
  }
}
