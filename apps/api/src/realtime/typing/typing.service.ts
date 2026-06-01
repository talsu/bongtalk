import { Inject, Injectable, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { TYPING_TTL, TYPING_MAX_VISIBLE, TYPING_THROTTLE } from '@qufox/shared-types';
import { REDIS } from '../../redis/redis.module';

/**
 * S32 (FR-RT-17): 타이핑 인디케이터 backing store.
 *
 * Redis layout (qufox: prefix applied by the client):
 *   typing:channel:{channelId}      ZSET  member=userId, score=만료 epoch ms
 *                                   TTL   TYPING_TTL_SEC + safety(5s) — 빈 채널 GC
 *   typing:throttle:{userId}:{chId} STR   per-(userId, channelId) 스로틀 키
 *                                   TTL   TYPING_THROTTLE_SEC
 *
 * 설계 결정 (S32 / D17):
 *   - 종전 SET 구현은 ping 마다 채널 키 전체 TTL 을 리셋해, A 가 멈췄어도 B 가
 *     계속 입력하면 A 가 stale 하게 살아남는 버그가 있었습니다(FR-RT-17 위반).
 *     ZSET(member=userId, score=만료 epoch)으로 전환해 **유저별 독립 만료**를
 *     달성합니다 — read 시 ZRANGEBYSCORE(now,+inf) 로 유효 멤버만 보고,
 *     lazy ZREMRANGEBYSCORE(0, now) 로 만료분을 정리합니다.
 *   - now 는 `Date.now()` 를 직접 쓰지 않고 redis TIME(또는 테스트 주입 clock)을
 *     씁니다(분산 환경 단조성 + 테스트 결정성).
 *   - PRD 의 문자열-키(typing:{channelId}:{userId} per-key TTL)와 형태는 다르나
 *     **동등 의미(per-user 독립 만료)**를 달성합니다. KEYS 스캔을 피하려고 채널당
 *     단일 ZSET 으로 모읍니다.
 *   - At-most-once. 타이핑은 ephemeral — drop 된 ping 은 인디케이터가 약간 더
 *     일찍 꺼질 뿐입니다.
 */
@Injectable()
export class TypingService {
  /**
   * 테스트 결정성을 위해 주입 가능한 clock. 기본은 redis TIME 으로, 분산
   * 환경에서도 단일 시간 출처를 쓰며 노드 시계 편차에 영향받지 않습니다.
   * 테스트는 생성자에 고정 clock 을 주입해 만료 경계를 결정적으로 검증합니다.
   */
  private readonly now: () => Promise<number>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    // 테스트만 주입하는 clock. 프로덕션 DI 는 undefined → redis TIME 폴백.
    // @Optional() 로 Nest 가 미해결 파라미터를 에러 없이 넘기게 합니다.
    @Optional() clock?: () => Promise<number>,
  ) {
    this.now = clock ?? (() => this.redisNowMs());
  }

  /** redis TIME → epoch ms. [secStr, microStr] 튜플을 ms 로 환산. */
  private async redisNowMs(): Promise<number> {
    const [secStr, microStr] = await this.redis.time();
    return Number(secStr) * 1000 + Math.floor(Number(microStr) / 1000);
  }

  private get ttlSec(): number {
    // S26 (FR-P07): 누락/비정상 env 는 ADR-8 값(10s)으로 폴백. finite/>0 가드로
    // 0-TTL ZSET(즉시 GC) 를 방지합니다.
    const raw = Number(process.env.TYPING_TTL_SEC ?? TYPING_TTL);
    return Number.isFinite(raw) && raw > 0 ? raw : TYPING_TTL;
  }

  private get throttleSec(): number {
    // S32 (contract #1): 리터럴 3 하드코딩을 제거하고 단일 출처(TYPING_THROTTLE)를
    // 폴백으로 사용합니다(클라 typingEmitter 스로틀과 동일 값 공유).
    const raw = Number(process.env.TYPING_THROTTLE_SEC ?? TYPING_THROTTLE);
    return Number.isFinite(raw) && raw > 0 ? raw : TYPING_THROTTLE;
  }

  /**
   * S26 (FR-P07): 와이어 페이로드가 이름 짓는 최대 typer 수. ZSET 은 더 많이
   * 담을 수 있으나(만료로 자연 정리), 브로드캐스트는 이 값으로 상한을 둡니다.
   */
  private get maxVisible(): number {
    const raw = Number(process.env.TYPING_MAX_VISIBLE ?? TYPING_MAX_VISIBLE);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : TYPING_MAX_VISIBLE;
  }

  private channelKey(channelId: string): string {
    return `typing:channel:${channelId}`;
  }

  private throttleKey(userId: string, channelId: string): string {
    return `typing:throttle:${userId}:${channelId}`;
  }

  /**
   * (userId, channelId) 를 typing 으로 등록합니다. 스로틀 창이 아직 살아 있으면
   * `null` 을 반환합니다(호출자는 emit 하지 않음 — 직전 브로드캐스트가 이미 이
   * 사용자를 이름 지었습니다). 성공 시 capVisible 적용된 유효 typer 목록을 반환.
   */
  async ping(userId: string, channelId: string): Promise<string[] | null> {
    const tk = this.throttleKey(userId, channelId);
    // SET NX + 짧은 TTL = 단발 스로틀. 이미 존재(NX 실패)면 창 안입니다.
    const throttleAck = await this.redis.set(tk, '1', 'EX', this.throttleSec, 'NX');
    if (throttleAck !== 'OK') return null;

    const sk = this.channelKey(channelId);
    const now = await this.now();
    const expireAt = now + this.ttlSec * 1000;
    // S32 (perf R-1): ping hot-path 를 4→3 round-trip 으로 축소합니다. 종전엔
    // multi[ZREMRANGEBYSCORE, ZADD, EXPIRE] 를 한 번 보내고, 멤버 목록을 위해
    // 별도 multi[ZREMRANGEBYSCORE, ZRANGEBYSCORE] 를 또 보냈습니다(중복 GC +
    // 추가 round-trip). 이제 단일 multi 에 ZRANGEBYSCORE 까지 묶어 멤버 목록을
    // 같은 왕복에서 받습니다(중복 ZREMRANGEBYSCORE 제거). 경계: ZADD 이후의
    // ZRANGEBYSCORE 가 `(now` exclusive 라, 방금 추가분(score = now+ttl > now)은
    // 항상 포함됩니다(트리거한 typer 보존).
    const pipe = this.redis.multi();
    // 만료분 lazy GC + 이 사용자의 만료 시각 갱신.
    pipe.zremrangebyscore(sk, 0, now);
    pipe.zadd(sk, expireAt, userId);
    // 빈 채널 GC 안전망: ZSET 키에도 TTL(=TTL+5s)을 둡니다. 멤버별 score 가
    // 진짜 만료를 결정하고, 이 키 TTL 은 모두 빠진 채널의 빈 ZSET 잔류만 막습니다.
    pipe.expire(sk, this.ttlSec + 5);
    // 유효(미만료) 멤버 목록을 같은 round-trip 에서 회수.
    pipe.zrangebyscore(sk, `(${now}`, '+inf');
    const res = (await pipe.exec()) ?? [];
    const members = extractMembers(res[3]?.[1]);
    // S26 (FR-P07): 방금 ping 한 사용자를 앞에 고정(busy 채널에서도 트리거한
    // typer 가 절대 빠지지 않게)하고 나머지를 결정적(sorted)으로 채웁니다.
    return this.capVisible(members, userId);
  }

  /**
   * S26 (FR-P07): 현재 typing 집합(최대 maxVisible). `priorityUserId` 는 슬롯이
   * 보장됩니다. ZSET 전체는 만료 score 와 함께 Redis 에 남아 있고, 이 함수는
   * 와이어로 나가는 것만 상한합니다.
   */
  async currentlyTyping(channelId: string, priorityUserId?: string): Promise<string[]> {
    const sk = this.channelKey(channelId);
    const now = await this.now();
    const members = await this.validMembers(sk, now);
    return this.capVisible(members, priorityUserId);
  }

  /**
   * 유효(미만료) 멤버 조회 + 만료분 lazy GC. ZRANGEBYSCORE(now, +inf) 로 아직
   * 만료되지 않은 멤버만 가져오고, 같은 호출에서 ZREMRANGEBYSCORE(0, now) 로
   * 만료분을 청소합니다. 한 유저가 멈춰도 다른 유저 ping 으로 stale 하게 살아남지
   * 않습니다(FR-RT-17).
   */
  private async validMembers(channelKey: string, now: number): Promise<string[]> {
    const pipe = this.redis.multi();
    pipe.zremrangebyscore(channelKey, 0, now);
    pipe.zrangebyscore(channelKey, `(${now}`, '+inf');
    const res = (await pipe.exec()) ?? [];
    return extractMembers(res[1]?.[1]);
  }

  /** 결정적으로 maxVisible 로 상한하되 priorityUserId 슬롯을 고정. */
  private capVisible(members: string[], priorityUserId?: string): string[] {
    if (members.length <= this.maxVisible) return members;
    const sorted = [...members].sort();
    if (priorityUserId && sorted.includes(priorityUserId)) {
      const rest = sorted.filter((id) => id !== priorityUserId);
      return [priorityUserId, ...rest].slice(0, this.maxVisible);
    }
    return sorted.slice(0, this.maxVisible);
  }

  /**
   * task-021-R1-typing-stale-on-clear: 클라가 draft 를 비울 때의 stop 신호.
   * 사용자를 ZSET 에서 ZREM 하고 스로틀 키를 제거해, 다음 ping 이 최대 3초간
   * 침묵당하지 않게 합니다. 호출자는 갱신된 집합을 채널 룸으로 브로드캐스트합니다.
   */
  async stop(userId: string, channelId: string): Promise<{ changed: boolean; members: string[] }> {
    const sk = this.channelKey(channelId);
    const tk = this.throttleKey(userId, channelId);
    const now = await this.now();
    // S32 (perf R-1): ping 과 동일하게 단일 multi 에 멤버 조회까지 묶어 별도
    // round-trip(validMembers) 을 제거합니다. ZREM(이 사용자 제거) → DEL(스로틀
    // 키) → ZREMRANGEBYSCORE(만료분 lazy GC) → ZRANGEBYSCORE(유효 멤버) 순서라
    // 반환 멤버 목록은 방금 제거한 사용자를 포함하지 않습니다.
    const pipe = this.redis.multi();
    pipe.zrem(sk, userId);
    pipe.del(tk);
    pipe.zremrangebyscore(sk, 0, now);
    pipe.zrangebyscore(sk, `(${now}`, '+inf');
    const res = (await pipe.exec()) ?? [];
    const zremCount = Number(res[0]?.[1] ?? 0);
    const members = extractMembers(res[3]?.[1]);
    // S26 (FR-P07): stop 이후 집합도 와이어용으로 상한.
    return { changed: zremCount > 0, members: this.capVisible(members) };
  }

  /**
   * 사용자를 모든 채널 ZSET 에서 선제 제거합니다(disconnect 훅). TTL 보다 빠르게
   * 인디케이터가 꺼지도록. `channelIds` 는 소켓 state 에서 옵니다(역인덱스 불필요).
   * 반환값은 실제로 제거가 일어난 channelId 목록입니다.
   */
  async dropForUser(userId: string, channelIds: string[]): Promise<string[]> {
    if (channelIds.length === 0) return [];
    const pipe = this.redis.multi();
    for (const chId of channelIds) {
      pipe.zrem(this.channelKey(chId), userId);
    }
    const results = (await pipe.exec()) ?? [];
    const changed: string[] = [];
    results.forEach(([, removed], i) => {
      if (Number(removed ?? 0) > 0) changed.push(channelIds[i]);
    });
    return changed;
  }
}

/**
 * S32 (perf R-1): multi.exec() 의 ZRANGEBYSCORE 결과 슬롯을 string[] 로 안전
 * 추출합니다. ioredis 는 `[err, result]` 튜플 배열을 반환하므로 result 칸만
 * 꺼내고, 형식이 어긋나면 빈 배열로 폴백합니다(에러로 hot-path 가 throw 하지
 * 않도록).
 */
function extractMembers(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as string[]) : [];
}
