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
 * 보유 멤버 1000명 초과 시 RoleCacheQueueService 가 넘긴 Job 을 처리한다. 영향받는
 * 채널들의 `perms:{channelId}:{roleId}` 키를 청크(500) 단위 pipeline DEL 한다.
 * DB cascade(MemberRole 삭제)는 이미 끝났으므로 본 worker 는 캐시 정리만 한다 —
 * 실패해도 캐시 miss 시 DB 재계산으로 정확성이 보장된다(FR-RM14/15 정합).
 */
@Processor(ROLE_CACHE_QUEUE)
export class RoleCacheProcessor extends WorkerHost {
  private readonly logger = new Logger(RoleCacheProcessor.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async process(job: Job<RoleCacheJobData>): Promise<void> {
    const { channelIds, roleId } = job.data;
    for (let i = 0; i < channelIds.length; i += ROLE_CACHE_BATCH_CHUNK) {
      const chunk = channelIds.slice(i, i + ROLE_CACHE_BATCH_CHUNK);
      const pipeline = this.redis.pipeline();
      for (const channelId of chunk) {
        pipeline.del(roleCacheKey(channelId, roleId));
      }
      await pipeline.exec();
    }
    this.logger.log(
      `[role-cache] invalidated role=${roleId} channels=${channelIds.length} (batch)`,
    );
  }
}
