import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { SEQ_SENTINEL } from '@qufox/shared-types';
import { REDIS } from '../../redis/redis.module';

/**
 * S10 (FR-RT-06): 채널 단위 단조 증가 seq 발급기.
 *
 * 채널 스코프 실시간 이벤트(message.created/updated/deleted, typing, read 등
 * channel:{id} 룸으로 emit 되는 이벤트)마다 `Redis INCR seq:{channelId}` 로
 * 채널별 단조 증가 Int64 를 만들어 emit 페이로드의 `seq` 필드를 채웁니다.
 * 클라이언트는 이 값으로 채널별 갭(누락)을 감지합니다.
 *
 * seq 는 **갭 감지 힌트 전용**입니다 — 렌더 정렬은 여전히 메시지 id(cuid2/uuid)
 * 기준입니다. 따라서 seq 발급은 정합성보다 가용성이 우선입니다: Redis 장애로
 * INCR 가 throw 하면 예외를 삼키고 `SEQ_SENTINEL(-1)` 을 반환해 fanout 을
 * 멈추지 않습니다(클라이언트는 sentinel 수신 시 hole 판정을 skip).
 */
@Injectable()
export class ChannelSeqService {
  private readonly logger = new Logger(ChannelSeqService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(channelId: string): string {
    return `seq:${channelId}`;
  }

  /**
   * S99 (S10 carryover · LOW): Redis 의 raw seq 문자열을 안전한 정수 baseline 으로
   * 정규화한다. 키 없음(null/undefined) 또는 비유한(NaN/±Infinity — 손상·비정수
   * 값) 은 모두 0(미관측 baseline)으로 떨어뜨려, NaN 이 setBaseline 을 거쳐 클라
   * seqTracker 의 monotonic 비교를 영구 hole 로 굳히는 것을 막는다.
   */
  private parseSeq(raw: string | null | undefined): number {
    if (raw === null || raw === undefined) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 채널 seq 를 1 증가시키고 새 값을 반환합니다. Redis 장애 시 SEQ_SENTINEL.
   */
  async next(channelId: string): Promise<number> {
    try {
      return await this.redis.incr(this.key(channelId));
    } catch (err) {
      this.logger.warn(
        `[realtime] seq INCR failed channel=${channelId} → sentinel err=${String(err).slice(0, 200)}`,
      );
      return SEQ_SENTINEL;
    }
  }

  /**
   * 현재 채널 seq 값을 읽습니다(증가 없음). join 스냅샷(ChannelJoinedPayload.seq)
   * 용. 키가 없으면 0, 장애 시 SEQ_SENTINEL.
   */
  async current(channelId: string): Promise<number> {
    try {
      const raw = await this.redis.get(this.key(channelId));
      // S99 (S10 carryover · LOW): 비정수/손상 Redis 값(예: 수동 SET 'foo')은
      // Number('foo')=NaN 이 되어 baseline 으로 흘러가면 클라 seqTracker 가
      // NaN 과의 비교(seq === prev+1 등)에서 영구 hole 로 굳는다. 키 없음(null)
      // 만 0 폴백하던 데서, 비유한 파싱 결과도 0 으로 정규화한다.
      return this.parseSeq(raw);
    } catch (err) {
      this.logger.warn(
        `[realtime] seq GET failed channel=${channelId} → sentinel err=${String(err).slice(0, 200)}`,
      );
      return SEQ_SENTINEL;
    }
  }

  /**
   * S10 fix-forward (MAJOR #2): connect 시 채널별 seq 스냅샷을 한 번에 읽어
   * `channel:joined` baseline 으로 emit 하기 위한 배치 GET. 채널 수만큼 단건
   * GET 을 돌리는 대신 단일 MGET 으로 묶어 연결당 1회 라운드트립으로 끝냅니다
   * (브리프의 "무한 emit/부하 주의" 가드). 키 없음→0, 장애→전체 SEQ_SENTINEL.
   */
  async currentMany(channelIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (channelIds.length === 0) return out;
    try {
      const raws = await this.redis.mget(...channelIds.map((id) => this.key(id)));
      channelIds.forEach((id, i) => {
        // S99: current() 와 동일한 NaN 가드. 손상 값은 0(미관측 baseline)으로.
        out.set(id, this.parseSeq(raws[i]));
      });
    } catch (err) {
      this.logger.warn(
        `[realtime] seq MGET failed count=${channelIds.length} → sentinel err=${String(err).slice(0, 200)}`,
      );
      for (const id of channelIds) out.set(id, SEQ_SENTINEL);
    }
    return out;
  }
}
