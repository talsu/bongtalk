import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  UPLOAD_RL_WINDOW_15M_SEC,
  UPLOAD_RL_WINDOW_15M_MAX,
  UPLOAD_RL_WINDOW_1M_SEC,
  UPLOAD_RL_WINDOW_1M_MAX,
} from '@qufox/shared-types';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S54 (D11 / FR-AM-27): upload-url presigned 발급 rate-limit.
 *
 * 사용자당 3종 독립 한도(셋 중 하나라도 초과 시 429 UPLOAD_RATE_LIMIT):
 *   1. 15분 슬라이딩 60회   — Redis ZSET sliding window.
 *   2. 1분  슬라이딩 10회   — Redis ZSET sliding window(버스트 방어).
 *   3. 동시 미완료 세션 20개 — AttachmentUploadSession completed=false AND
 *      expiresAt>now COUNT(DB, 컨트롤러/서비스가 enforceConcurrent 로 위임).
 *
 * 슬라이딩 윈도우 알고리즘(ZSET): 각 발급 시 (score=now_ms, member=uuid) 를 ZADD →
 * 윈도우 밖(now - windowMs) 항목 ZREMRANGEBYSCORE → ZCARD 로 윈도우 내 개수 판정.
 * 카운터/타임스탬프는 전적으로 Redis 에 둔다(스테이트리스 API 수평 확장 — ADR).
 * 결정성: `at`(now) 을 주입받아 테스트가 vi.setSystemTime 과 무관히 윈도우를 제어한다.
 */
@Injectable()
export class UploadRateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(userId: string, suffix: string): string {
    return `upload-rl:${suffix}:${userId}`;
  }

  /**
   * 슬라이딩 윈도우 발급 1회 기록 + 한도 검사. `count` 만큼 멤버를 추가한다(upload-url
   * 한 번에 count 개 세션 발급 시 count 회로 친다). 한도 초과면 추가분을 롤백하지 않고
   * (이미 ZADD 됨) 그대로 둬 후속 호출도 차단되게 한다 — 보수적 게이트.
   */
  private async slidingHit(
    redisKey: string,
    windowSec: number,
    max: number,
    count: number,
    at: Date,
  ): Promise<boolean> {
    const nowMs = at.getTime();
    const windowStart = nowMs - windowSec * 1000;
    const pipeline = this.redis.multi();
    // 윈도우 밖(과거) 항목 제거.
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    // 이번 발급분 추가(동일 score 충돌 회피 위해 member 에 uuid).
    for (let i = 0; i < count; i++) {
      pipeline.zadd(redisKey, nowMs, `${nowMs}-${randomUUID()}`);
    }
    pipeline.zcard(redisKey);
    // 키 TTL 을 윈도우 길이로 재설정(자연 소멸 — 미사용 사용자 키 누수 방지).
    pipeline.expire(redisKey, windowSec);
    const res = await pipeline.exec();
    // exec 결과의 zcard 응답을 안전하게 추출(파이프라인 마지막에서 2번째).
    if (!res) return true;
    const zcardEntry = res[res.length - 2];
    const card = Array.isArray(zcardEntry) ? Number(zcardEntry[1]) : 0;
    return card <= max;
  }

  /**
   * FR-AM-27: 15분/1분 슬라이딩 윈도우 한도를 함께 검사. 둘 중 하나라도 초과 시
   * UPLOAD_RATE_LIMIT(429). 동시-세션(20개) 검사는 DB 카운트가 필요해 별도
   * (enforceConcurrent)로 분리한다.
   *
   * @param count 이번 upload-url 호출이 발급할 세션 수(슬라이딩 카운트에 합산).
   * @param at    now(주입 — 테스트 결정성).
   */
  async enforceWindows(userId: string, count: number, at: Date = new Date()): Promise<void> {
    const ok15 = await this.slidingHit(
      this.key(userId, '15m'),
      UPLOAD_RL_WINDOW_15M_SEC,
      UPLOAD_RL_WINDOW_15M_MAX,
      count,
      at,
    );
    const ok1 = await this.slidingHit(
      this.key(userId, '1m'),
      UPLOAD_RL_WINDOW_1M_SEC,
      UPLOAD_RL_WINDOW_1M_MAX,
      count,
      at,
    );
    if (!ok15 || !ok1) {
      throw new DomainError(
        ErrorCode.UPLOAD_RATE_LIMIT,
        'upload-url rate limit exceeded (sliding window)',
      );
    }
  }

  /** 테스트/운영 보조: 사용자 슬라이딩 윈도우 키 초기화. */
  async reset(userId: string): Promise<void> {
    await this.redis.del(this.key(userId, '15m'), this.key(userId, '1m'));
  }
}
