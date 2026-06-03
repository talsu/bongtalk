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

  private static cardOf(res: unknown[] | null, idx: number): number {
    if (!res) return 0;
    const entry = res[idx];
    // ioredis pipeline exec → [err, value] 튜플. mock 도 동일 형태.
    return Array.isArray(entry) ? Number(entry[1] ?? 0) : Number(entry ?? 0);
  }

  /**
   * FR-AM-27: 15분/1분 슬라이딩 윈도우 한도를 함께 검사.
   *
   * S54 리뷰 H2(sticky lockout) fix: **check-then-add**. 종전엔 무조건 ZADD 후 검사라
   * 429 를 받은 클라가 재시도할수록 두 윈도우가 거부 요청으로 차 정상 사용자를
   * self-DoS 시켰다(게다가 15m→1m 순차 hit 로 1m 초과 시 15m 까지 오염). 이제 (1) 두
   * 윈도우를 정리+카운트만 하고(peek·추가 없음) (2) 둘 다 여유가 있을 때만 멤버를
   * 추가(commit)한다. 거부 요청은 카운터를 소비하지 않는다. peek↔commit 사이 동시성
   * race 는 동시-세션 cap(20)·1분 cap(10)이 bound 하므로 soft 하게 허용한다.
   *
   * @param count 이번 upload-url 호출이 발급할 세션 수(슬라이딩 카운트에 합산).
   * @param at    now(주입 — 테스트 결정성).
   */
  async enforceWindows(userId: string, count: number, at: Date = new Date()): Promise<void> {
    const nowMs = at.getTime();
    const k15 = this.key(userId, '15m');
    const k1 = this.key(userId, '1m');
    // (1) peek — 윈도우 밖 정리 후 현재 개수만 읽는다(추가 없음).
    const peek = this.redis.multi();
    peek.zremrangebyscore(k15, 0, nowMs - UPLOAD_RL_WINDOW_15M_SEC * 1000);
    peek.zremrangebyscore(k1, 0, nowMs - UPLOAD_RL_WINDOW_1M_SEC * 1000);
    peek.zcard(k15);
    peek.zcard(k1);
    const res = await peek.exec();
    const card15 = UploadRateLimitService.cardOf(res, 2);
    const card1 = UploadRateLimitService.cardOf(res, 3);
    if (card15 + count > UPLOAD_RL_WINDOW_15M_MAX || card1 + count > UPLOAD_RL_WINDOW_1M_MAX) {
      throw new DomainError(
        ErrorCode.UPLOAD_RATE_LIMIT,
        'upload-url rate limit exceeded (sliding window)',
      );
    }
    // (2) commit — 둘 다 여유가 있으므로 양쪽에 멤버 추가 + TTL 갱신.
    const commit = this.redis.multi();
    for (let i = 0; i < count; i++) {
      const member = `${nowMs}-${randomUUID()}`;
      commit.zadd(k15, nowMs, member);
      commit.zadd(k1, nowMs, member);
    }
    commit.expire(k15, UPLOAD_RL_WINDOW_15M_SEC);
    commit.expire(k1, UPLOAD_RL_WINDOW_1M_SEC);
    await commit.exec();
  }

  /** 테스트/운영 보조: 사용자 슬라이딩 윈도우 키 초기화. */
  async reset(userId: string): Promise<void> {
    await this.redis.del(this.key(userId, '15m'), this.key(userId, '1m'));
  }
}
