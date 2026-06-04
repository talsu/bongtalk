import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { REDIS } from '../redis/redis.module';

/**
 * S72 (D13 / FR-W16): 서버 디스커버리 검색 Redis 5분 캐시.
 *
 * 키 전략(NAS 단일 노드 권장 — 버전 키):
 *   `discover:v{ver}:{hash}` 에서 ver = `discover:ver` 값(없으면 0),
 *   hash = sha256({category|q|cursor|limit}) 앞 16자.
 * invalidation 은 `discover:ver` 를 INCR 해 네임스페이스를 통째로 옮긴다 — SCAN/DEL
 * 없이 O(1) 이며, 구 버전 키는 5분 TTL 로 자연 소멸한다. 캐시 스탬피드는 5분 TTL 로
 * 수용한다(mutex 불필요).
 */
export type DiscoverCacheKeyInput = {
  category?: string;
  q?: string;
  cursor: string | null;
  limit: number;
};

export const DISCOVER_CACHE_TTL_SEC = 300;
const VERSION_KEY = 'discover:ver';

@Injectable()
export class DiscoverCacheService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private async version(): Promise<number> {
    const raw = await this.redis.get(VERSION_KEY);
    return raw ? Number(raw) : 0;
  }

  /**
   * 입력을 정규화(category/q 트림)한 뒤 안정 해시로 캐시 키를 만든다. 빈 category 와
   * 빈 q 는 동일하게 취급된다(discover 서비스의 cat/q 트림과 대칭).
   */
  async keyFor(input: DiscoverCacheKeyInput): Promise<string> {
    const ver = await this.version();
    const normalized = {
      category: (input.category ?? '').trim(),
      q: (input.q ?? '').trim(),
      cursor: input.cursor ?? '',
      limit: input.limit,
    };
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
    return `discover:v${ver}:${hash}`;
  }

  /** MISS → null, HIT → 파싱된 payload. */
  async read<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  /** payload 를 300s TTL 로 SET EX 한다. */
  async write(key: string, payload: unknown): Promise<void> {
    await this.redis.set(key, JSON.stringify(payload), 'EX', DISCOVER_CACHE_TTL_SEC);
  }

  /** 버전 키를 bump 해 이후 모든 discover 캐시 키를 새 네임스페이스로 옮긴다. */
  async invalidate(): Promise<void> {
    await this.redis.incr(VERSION_KEY);
  }
}
