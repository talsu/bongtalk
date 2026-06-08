import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { REDIS } from '../../redis/redis.module';

/**
 * FR-RM10b (069 / ADR): MENTION_SPAM / REPEAT_SPAM 행동형 트리거의 Redis sliding window.
 *
 * upload-rate-limit.service 의 ZSET 슬라이딩 윈도우 패턴(ZADD score=now · ZREMRANGEBYSCORE
 * 로 윈도 밖 정리 · ZCARD 카운트)을 재사용한다. 모든 카운터는 Redis 에 둔다(스테이트리스
 * API 수평 확장). 결정성: now(at) 를 주입받아 테스트가 vi.setSystemTime 과 무관히 윈도를 제어.
 *
 * best-effort: Redis 오류는 흡수하고 0(미초과)을 반환한다 — 모더레이션 spam 카운트가 송신
 * 자체를 막지 않는다(메시지 통과 우선). 키에 TTL(windowSeconds)을 둬 idle 작성자 키를 자동
 * 정리한다.
 *
 * 키 구조:
 *   MENTION_SPAM: automod:mspam:{workspaceId}:{ruleId}:{userId}
 *     — member = `{nowMs}-{randomUUID}`(멘션당 1 멤버 · mentionCount 만큼 ZADD) · ZCARD ≥ threshold.
 *   REPEAT_SPAM:  automod:rspam:{workspaceId}:{ruleId}:{userId}:{contentHash}
 *     — 정규화 본문 해시별 ZSET · member = `{nowMs}-{randomUUID}`(고유) · ZCARD = 윈도 내 동일 본문
 *       반복 수. MED-3: member 의 randomUUID 가 다중노드 동일 ms 충돌(언더카운트)을 막는다.
 */
@Injectable()
export class AutoModSpamService {
  private readonly logger = new Logger(AutoModSpamService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * MED-3 (069 fix-forward · 다중노드 충돌): ZSET member 의 고유화 토큰. 종전 `${nowMs}-${seq++}`
   * 는 per-process 카운터라, 수평 확장한 다중 API 노드가 같은 ms 에 같은 seq 로 ZADD 하면 ZSET 이
   * 같은 member 를 덮어써(ZADD 갱신) 카운트가 언더된다(spam 회피). process-unique 한 randomUUID 를
   * 섞어 노드/시점이 같아도 member 충돌이 없게 한다(ZCARD = 실제 누적 수).
   */
  private uniqueMember(nowMs: number): string {
    return `${nowMs}-${randomUUID()}`;
  }

  /**
   * FR-RM10b: 정규화 본문 해시. 소문자 · trim · 공백 단일화 후 sha256 prefix(16hex).
   * 빈 본문은 빈 해시('')를 반환(REPEAT_SPAM 평가 skip 용).
   */
  static contentHash(contentPlain: string): string {
    const normalized = contentPlain.toLowerCase().trim().replace(/\s+/g, ' ');
    if (normalized.length === 0) return '';
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * MENTION_SPAM: 이번 메시지의 mentionCount 를 작성자별 ZSET 에 누적하고 윈도 내 합을 반환.
   * 합 ≥ mentionThreshold 면 호출부가 액션을 집행한다.
   *
   * @returns 윈도 내 누적 멘션 수(이번 메시지 포함). Redis 오류/멘션 0 시 0.
   */
  async recordAndCountMentions(args: {
    workspaceId: string;
    ruleId: string;
    userId: string;
    mentionCount: number;
    windowSeconds: number;
    at?: Date;
  }): Promise<number> {
    if (args.mentionCount <= 0) return 0;
    const nowMs = (args.at ?? new Date()).getTime();
    const key = `automod:mspam:${args.workspaceId}:${args.ruleId}:${args.userId}`;
    const cutoff = nowMs - args.windowSeconds * 1000;
    try {
      const pipe = this.redis.multi();
      pipe.zremrangebyscore(key, 0, cutoff);
      for (let i = 0; i < args.mentionCount; i++) {
        pipe.zadd(key, nowMs, this.uniqueMember(nowMs));
      }
      pipe.zcard(key);
      pipe.expire(key, args.windowSeconds);
      const res = await pipe.exec();
      // 마지막에서 두 번째 명령이 ZCARD(zadd count 개 + zrem + zcard + expire).
      return cardOf(res, 1 + args.mentionCount);
    } catch (err) {
      this.logger.warn(`[automod] mspam redis error: ${String(err).slice(0, 160)}`);
      return 0;
    }
  }

  /**
   * REPEAT_SPAM: 이번 본문 해시를 작성자·해시별 ZSET 에 누적하고 윈도 내 동일 본문 반복 수를
   * 반환한다. 반복 수 ≥ repeatThreshold 면 호출부가 액션을 집행한다.
   *
   * @returns 윈도 내 동일 본문 반복 수(이번 포함). 빈 본문/Redis 오류 시 0.
   */
  async recordAndCountRepeats(args: {
    workspaceId: string;
    ruleId: string;
    userId: string;
    contentPlain: string;
    windowSeconds: number;
    at?: Date;
  }): Promise<number> {
    const hash = AutoModSpamService.contentHash(args.contentPlain);
    if (hash.length === 0) return 0;
    const nowMs = (args.at ?? new Date()).getTime();
    const key = `automod:rspam:${args.workspaceId}:${args.ruleId}:${args.userId}:${hash}`;
    const cutoff = nowMs - args.windowSeconds * 1000;
    try {
      const pipe = this.redis.multi();
      pipe.zremrangebyscore(key, 0, cutoff);
      pipe.zadd(key, nowMs, this.uniqueMember(nowMs));
      pipe.zcard(key);
      pipe.expire(key, args.windowSeconds);
      const res = await pipe.exec();
      // 명령 순서: zrem(0) · zadd(1) · zcard(2) · expire(3).
      return cardOf(res, 2);
    } catch (err) {
      this.logger.warn(`[automod] rspam redis error: ${String(err).slice(0, 160)}`);
      return 0;
    }
  }

  /** 테스트/운영 보조: 작성자의 spam 윈도 키 초기화(prefix scan 후 삭제). */
  async reset(workspaceId: string, ruleId: string, userId: string): Promise<void> {
    const mKey = `automod:mspam:${workspaceId}:${ruleId}:${userId}`;
    const rPattern = `automod:rspam:${workspaceId}:${ruleId}:${userId}:*`;
    try {
      const rKeys = await this.redis.keys(rPattern);
      await this.redis.del(mKey, ...rKeys);
    } catch {
      // best-effort.
    }
  }
}

/** ioredis pipeline exec → [err, value] 튜플에서 idx 의 정수 카운트(mock 도 동일 형태). */
function cardOf(res: unknown[] | null, idx: number): number {
  if (!res) return 0;
  const entry = res[idx];
  return Array.isArray(entry) ? Number(entry[1] ?? 0) : Number(entry ?? 0);
}
