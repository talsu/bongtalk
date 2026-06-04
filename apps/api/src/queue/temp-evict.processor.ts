import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { OutboxService } from '../common/outbox/outbox.service';
import { MEMBER_LEFT } from '../workspaces/events/workspace-events';
import {
  TEMP_EVICT_QUEUE,
  TEMP_EVICT_POLL_INTERVAL_MS,
  type TempEvictJobData,
} from './temp-evict-queue.constants';
import { TempEvictQueueService } from './temp-evict-queue.service';

/**
 * S70 (D13 / FR-W12 · Fork A-1): 임시 멤버 자동 강퇴 worker(BullMQ in-process).
 *
 * disconnect 시 TempEvictQueueService 가 arm 한 2초 debounce 잡을 처리한다. 강퇴 절차
 * (오강퇴·잔존 정합 방어):
 *   (1) Redis Set SCARD 를 **재확인**. >0(2초 내 재연결 / 다른 기기·노드 소켓 잔존)이면 skip
 *       — Redis Set 이 진실원이라 멀티노드/다중기기에서 한 노드/기기 disconnect 만으로는
 *       강퇴되지 않는다.
 *   (2) WorkspaceMember 행 조회. 부재(이미 leave/kick)면 skip.
 *   (3) isTemporary=false(영구 멤버)면 skip — 임시 링크 가입 멤버(S67)만 대상.
 *   (4) tx: WorkspaceMember 삭제 + outbox MEMBER_LEFT(reason='temp_expired'). outbox→WS
 *       subscriber 가 ws:member_left{reason:'temp_expired'} 를 워크스페이스 룸으로 fanout
 *       하고, 대상 본인 소켓을 kickUserEverywhere 로 끊는다(기존 member.left 경로 재사용).
 *
 * drainDelay 를 낮춰 2초 debounce 정밀도를 확보한다(아래 매핑 주석 참조).
 */
// FR-W12 강퇴 지연 ≈ 3초(2초 delay + 최대 1초 drain): BullMQ 5 는 명시적 pollInterval 이
// 없고, delayed job 은 delayed-marker 로 즉시 승격되지만 worker 가 blocking 대기에서 깨어나는
// 최악 지연은 drainDelay 에 좌우된다(기본 5s). TEMP_EVICT_POLL_INTERVAL_MS(250ms)를 초로
// 환산·반올림하면 0 이라 Math.max(1, …) 가 최소 1초 drainDelay 를 보장한다. 따라서 2초
// debounce delay + 최대 1초 drain 으로 강퇴까지 최악 ~3초다(잡 수가 적어 추가 폴링 부하는
// 무시 가능 — 결정 1 의 "pollInterval 낮게"를 BullMQ 5 의 drainDelay 로 매핑).
@Processor(TEMP_EVICT_QUEUE, {
  concurrency: 4,
  drainDelay: Math.max(1, Math.round(TEMP_EVICT_POLL_INTERVAL_MS / 1000)),
})
export class TempEvictProcessor extends WorkerHost {
  private readonly logger = new Logger(TempEvictProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly evict: TempEvictQueueService,
  ) {
    super();
  }

  async process(job: Job<TempEvictJobData>): Promise<void> {
    const { userId, workspaceId } = job.data;

    // (1) SCARD 재확인 — 2초 내 재연결 / 다른 기기·노드 소켓 잔존이면 skip.
    const active = await this.evict.activeSocketCount(userId, workspaceId);
    if (active > 0) {
      this.logger.debug(
        `[temp-evict] skip (sockets active=${active}) user=${userId} ws=${workspaceId}`,
      );
      return;
    }

    // (2)(3) 임시 멤버인지 확인. 부재/영구 멤버면 skip.
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { isTemporary: true },
    });
    if (!member) {
      this.logger.debug(`[temp-evict] skip (not a member) user=${userId} ws=${workspaceId}`);
      return;
    }
    if (!member.isTemporary) {
      this.logger.debug(`[temp-evict] skip (permanent member) user=${userId} ws=${workspaceId}`);
      return;
    }

    // (4) tx: 멤버 삭제 + outbox MEMBER_LEFT(reason='temp_expired'). 동시 leave/kick 레이스로
    // 행이 이미 사라지면 P2025 → 멱등 skip(이미 떠남).
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.delete({
          where: { workspaceId_userId: { workspaceId, userId } },
        });
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: userId,
          eventType: MEMBER_LEFT,
          // actorId=userId(시스템 강퇴지만 대상=본인) + reason 으로 ws:member_left wire 를 분기.
          payload: { workspaceId, userId, actorId: userId, reason: 'temp_expired' },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        this.logger.debug(`[temp-evict] skip (already gone) user=${userId} ws=${workspaceId}`);
        return;
      }
      throw e;
    }

    this.logger.log(`[temp-evict] evicted temporary member user=${userId} ws=${workspaceId}`);
  }
}
