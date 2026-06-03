import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import {
  ROLE_CACHE_QUEUE,
  ROLE_CACHE_INVALIDATE_JOB,
  ROLE_CACHE_JOB_OPTS,
  ROLE_CACHE_BATCH_THRESHOLD,
  roleCacheKey,
  type RoleCacheJobData,
} from './role-cache-queue.constants';

/**
 * S61 (D12 / FR-RM15): 역할 삭제 cascade 시 권한 캐시 무효화 facade.
 *
 * RolesService 가 Role 삭제 트랜잭션 직후 호출한다. 보유 멤버 수가
 * ROLE_CACHE_BATCH_THRESHOLD(1000)명 이하면 즉시(동기) Redis DEL 하고, 초과면
 * BullMQ 배치 Job 으로 넘긴다. 어느 경로든 DB(MemberRole) cascade 삭제가 이미
 * 끝났으므로 권한 재계산은 즉시 정확하다 — 캐시 DEL 은 stale window 를 닫는 보강이다.
 *
 * RealtimeModule/도메인 의존 없음(Redis 만) → QueueModule 순환 회피.
 */
@Injectable()
export class RoleCacheQueueService {
  private readonly logger = new Logger(RoleCacheQueueService.name);

  constructor(
    @InjectQueue(ROLE_CACHE_QUEUE) private readonly queue: Queue<RoleCacheJobData>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 삭제된 역할의 권한 캐시를 무효화한다. 멤버 수에 따라 즉시 DEL vs 배치 Job 분기.
   * best-effort — Redis 일시 실패는 warn 만(DB 가 진실원, 캐시 miss 시 재계산).
   */
  async invalidateForDeletedRole(args: RoleCacheJobData): Promise<void> {
    const memberCount = args.userIds.length;
    if (memberCount === 0 || args.channelIds.length === 0) return;

    if (memberCount > ROLE_CACHE_BATCH_THRESHOLD) {
      // >1000명: BullMQ 배치 — 요청 응답을 막지 않는다.
      try {
        await this.queue.add(ROLE_CACHE_INVALIDATE_JOB, args, {
          ...ROLE_CACHE_JOB_OPTS,
          jobId: `${args.workspaceId}:${args.roleId}`,
        });
        this.logger.log(
          `[role-cache] batched invalidate role=${args.roleId} members=${memberCount}`,
        );
      } catch (err) {
        this.logger.warn(`[role-cache] enqueue failed role=${args.roleId}: ${trunc(err)}`);
      }
      return;
    }

    // ≤1000명: 즉시 DEL. 역할 캐시 키는 채널 단위(`perms:{channelId}:{roleId}`)라
    // 멤버 수와 무관하게 채널 수만큼이다 — 채널별로 DEL 한다.
    try {
      await delRoleKeys(this.redis, args.channelIds, args.roleId);
    } catch (err) {
      this.logger.warn(`[role-cache] inline del failed role=${args.roleId}: ${trunc(err)}`);
    }
  }
}

/**
 * S61: `perms:{channelId}:{roleId}` 키들을 pipeline DEL 한다. keyPrefix('qufox:')는
 * ioredis 가 자동 부착하므로 여기서는 붙이지 않는다.
 */
export async function delRoleKeys(
  redis: Redis,
  channelIds: string[],
  roleId: string,
): Promise<void> {
  if (channelIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const channelId of channelIds) {
    pipeline.del(roleCacheKey(channelId, roleId));
  }
  await pipeline.exec();
}

function trunc(err: unknown): string {
  return String(err).slice(0, 160);
}
