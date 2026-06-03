import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import {
  ROLE_CACHE_QUEUE,
  ROLE_CACHE_BATCH_CHUNK,
  roleCacheKey,
  type RoleCacheJobData,
} from './role-cache-queue.constants';

/**
 * S61 (D12 / FR-RM15): 역할 삭제 cascade 의 권한 캐시 무효화 배치 worker.
 *
 * 보유 멤버 1000명 초과 시 RoleCacheQueueService 가 넘긴 Job 을 처리한다. S62: 권한
 * 캐시는 per-(channel, user)(`perms:{channelId}:{userId}`)라, 영향받은 멤버 × 채널
 * 조합 키를 청크(500) 단위 pipeline DEL 한다. DB cascade(MemberRole 삭제)는 이미
 * 끝났으므로 본 worker 는 캐시 정리만 한다 — 실패해도 캐시 miss 시 DB 재계산으로
 * 정확성이 보장된다(FR-RM14/15 정합).
 */
@Processor(ROLE_CACHE_QUEUE)
export class RoleCacheProcessor extends WorkerHost {
  private readonly logger = new Logger(RoleCacheProcessor.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async process(job: Job<RoleCacheJobData>): Promise<void> {
    const { channelIds, userIds, roleId } = job.data;
    // channel × user 조합을 평탄화해 청크 DEL(키 폭증 방지 · 500 단위 pipeline).
    const keys: string[] = [];
    for (const channelId of channelIds) {
      for (const userId of userIds) {
        keys.push(roleCacheKey(channelId, userId));
      }
    }
    for (let i = 0; i < keys.length; i += ROLE_CACHE_BATCH_CHUNK) {
      const chunk = keys.slice(i, i + ROLE_CACHE_BATCH_CHUNK);
      const pipeline = this.redis.pipeline();
      for (const key of chunk) {
        pipeline.del(key);
      }
      await pipeline.exec();
    }
    this.logger.log(`[role-cache] invalidated role=${roleId} keys=${keys.length} (batch)`);
  }
}
