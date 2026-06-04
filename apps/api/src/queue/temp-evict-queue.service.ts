import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import {
  TEMP_EVICT_QUEUE,
  TEMP_EVICT_JOB,
  TEMP_EVICT_JOB_OPTS,
  TEMP_EVICT_DEBOUNCE_MS,
  TEMP_EVICT_SOCKETS_TTL_SEC,
  tempEvictJobId,
  tempEvictSocketsKey,
  type TempEvictJobData,
} from './temp-evict-queue.constants';

/**
 * S70 (D13 / FR-W12 · Fork A-1): 임시 멤버 강퇴 큐의 쓰기 facade + 활성 소켓 집계.
 *
 * RealtimeGateway 의 handleConnection/handleDisconnect 가 이 서비스를 호출한다. BullMQ
 * delayed job(2초 debounce)과 Redis Set(활성 socketId 집계)을 함께 다루며, 강퇴 emit/삭제
 * 는 TempEvictProcessor 가 담당한다(reminder 큐와 동일한 service↔processor 분리 — Realtime
 * Module 과의 순환을 피한다. QueueModule 이 @Global 이라 import 없이 주입 가능).
 *
 * 멀티노드/다중기기 안전: 활성 소켓은 Redis Set 에 모이므로 한 노드/기기의 disconnect 여도
 * 다른 노드/기기의 소켓이 set 에 남아있으면 SCARD>0 → 강퇴가 armed 되지 않거나 Processor 가
 * skip 한다. Redis 왕복 실패는 비-치명(warn) — 강퇴는 best-effort 운영 동작이다.
 */
@Injectable()
export class TempEvictQueueService {
  private readonly logger = new Logger(TempEvictQueueService.name);

  constructor(
    @InjectQueue(TEMP_EVICT_QUEUE) private readonly queue: Queue<TempEvictJobData>,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /**
   * connect 시: socketId 를 활성 Set 에 SADD + 기존 강퇴 잡 취소(remove). isTemporary
   * 워크스페이스의 소켓만 호출된다(게이트웨이가 connect 시 해당 ws isTemporary 를 조회 —
   * 전 소켓 SADD 금지, 결정 1). 2초 내 재연결이면 disconnect 가 arm 한 잡이 여기서 취소된다.
   */
  async onSocketConnect(args: {
    userId: string;
    workspaceId: string;
    socketId: string;
  }): Promise<void> {
    const { userId, workspaceId, socketId } = args;
    if (this.redis) {
      try {
        const key = tempEvictSocketsKey(userId, workspaceId);
        await this.redis.sadd(key, socketId);
        await this.redis.expire(key, TEMP_EVICT_SOCKETS_TTL_SEC);
      } catch (err) {
        this.logger.warn(
          `[temp-evict] sadd failed user=${userId} ws=${workspaceId}: ${String(err).slice(0, 160)}`,
        );
      }
    }
    // 재연결 → 예약된 강퇴 잡 취소(있으면). best-effort.
    await this.cancelEvict(userId, workspaceId);
  }

  /**
   * disconnect 시: socketId 를 활성 Set 에서 SREM. SCARD 가 0 이 되면(이 워크스페이스의
   * 마지막 소켓이 끊김) 2초 debounce 강퇴 잡을 arm 한다. SCARD>0(다른 기기/노드 소켓
   * 잔존)이면 arm 하지 않는다(다중기기 미실행). Redis 부재 시 강퇴를 arm 하지 않는다
   * (활성 소켓 집계 불가 → 안전하게 미실행).
   */
  async onSocketDisconnect(args: {
    userId: string;
    workspaceId: string;
    socketId: string;
  }): Promise<void> {
    const { userId, workspaceId, socketId } = args;
    if (!this.redis) return;
    let remaining = 0;
    try {
      const key = tempEvictSocketsKey(userId, workspaceId);
      await this.redis.srem(key, socketId);
      remaining = await this.redis.scard(key);
    } catch (err) {
      this.logger.warn(
        `[temp-evict] srem/scard failed user=${userId} ws=${workspaceId}: ${String(err).slice(0, 160)}`,
      );
      return;
    }
    if (remaining > 0) return; // 다른 소켓(기기/노드) 잔존 → 강퇴 미실행.
    await this.armEvict(userId, workspaceId);
  }

  /** 2초 debounce 강퇴 잡 등록(멱등 — 기존 잡 remove 후 add). best-effort. */
  private async armEvict(userId: string, workspaceId: string): Promise<void> {
    const jobId = tempEvictJobId(userId, workspaceId);
    try {
      await this.queue.remove(jobId).catch(() => undefined);
      await this.queue.add(
        TEMP_EVICT_JOB,
        { userId, workspaceId },
        { ...TEMP_EVICT_JOB_OPTS, jobId, delay: TEMP_EVICT_DEBOUNCE_MS },
      );
    } catch (err) {
      this.logger.warn(
        `[temp-evict] arm failed user=${userId} ws=${workspaceId}: ${String(err).slice(0, 160)}`,
      );
    }
  }

  /** 예약된 강퇴 잡 취소(connect/재연결 시). getJob 후 remove(없으면 no-op). best-effort. */
  async cancelEvict(userId: string, workspaceId: string): Promise<void> {
    try {
      await this.queue.remove(tempEvictJobId(userId, workspaceId));
    } catch (err) {
      this.logger.warn(
        `[temp-evict] cancel failed user=${userId} ws=${workspaceId}: ${String(err).slice(0, 160)}`,
      );
    }
  }

  /** Processor 가 강퇴 직전 SCARD 0 을 재확인하는 데 쓴다. Redis 부재 시 0 으로 본다. */
  async activeSocketCount(userId: string, workspaceId: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      return await this.redis.scard(tempEvictSocketsKey(userId, workspaceId));
    } catch {
      // 집계 실패 시 0 을 반환하지 않고 1 로 보아 강퇴를 보류한다(오강퇴 방지 — 보수적).
      return 1;
    }
  }
}
