import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { REDIS } from '../redis/redis.module';

/**
 * S72 (D13 / FR-W16): 서버 디스커버리 검색 Redis 캐시.
 *
 * 키 전략(NAS 단일 노드 권장 — 버전 키):
 *   `discover:v{ver}:{hash}` 에서 ver = `discover:ver` 값(없으면 0),
 *   hash = sha256({category|q|cursor|limit}) 앞 32자.
 * invalidation 은 `discover:ver` 를 INCR 해 네임스페이스를 통째로 옮긴다 — SCAN/DEL
 * 없이 O(1) 이며, 구 버전 키는 TTL 로 자연 소멸한다. 캐시 스탬피드는 TTL 로
 * 수용한다(mutex 불필요).
 *
 * S72 W16 fix-forward (MEDIUM-1, write-after-bump 안전성): keyFor() 는 호출 시점의
 * ver 로 키를 만들고, 그 키로 read/write 한다. discover 가 (1) keyFor → (2) DB 조회
 * → (3) write 하는 사이에 다른 요청이 invalidate()(ver bump)를 해도 안전하다.
 *   - read 측: 이후 요청은 새 ver 로 keyFor 하므로 구 ver 키를 절대 조회하지 않는다.
 *     즉 stale payload 는 read 경로에서 결코 서빙되지 않는다.
 *   - write 측: 구 ver 로 만들어진 키에 write 가 들어가도 그 키는 더 이상 read 대상이
 *     아니며(네임스페이스가 이동했으므로), TTL 후 소멸한다 — 고아 항목일 뿐 오답을
 *     서빙하지 않는다.
 *
 * S72 W16 fix-forward (HIGH-1, memberCount/커서 stale): memberCount 변동(가입/승인/
 * 초대 수락 등 멤버 수만 바뀌는 이벤트)은 의도적으로 invalidate() 하지 않는다 — 따라서
 * 캐시된 memberCount 는 최대 TTL 동안 stale 일 수 있다. 또한 discover 커서가
 * memberCount 기반(`{memberCount}|{id}`)이라, 동일 캐시 윈도우 안에서 멤버 수가 바뀌면
 * 페이지 경계 정합(누락/중복 가능성)도 같은 TTL 동안 stale 일 수 있다. stale 창을 줄이기
 * 위해 TTL 을 60s 로 둔다(W16 fix-forward 에서 300→60 축소). 멤버 수 정확도가 off-peak
 * 비용보다 우선이며 NAS 단일 노드에서 60s MISS 빈도는 수용 가능하다.
 *
 * TODO(S72 W16, security LOW): discover 응답에 사용자별 필드(가입 여부/ban 상태 등)가
 * 추가되면 캐시 키에 userId 를 포함하거나 그 경로만 캐시를 우회해야 한다 — 현재 응답은
 * 사용자 무관(공개 워크스페이스 목록)이라 공유 캐시가 안전하지만, 개인화 필드가 섞이면
 * 한 사용자의 상태가 다른 사용자에게 새어 나간다.
 */
export type DiscoverCacheKeyInput = {
  category?: string;
  q?: string;
  cursor: string | null;
  limit: number;
};

// S72 W16 fix-forward (HIGH-1): stale 창 단축을 위해 300→60s 로 축소.
export const DISCOVER_CACHE_TTL_SEC = 60;
const VERSION_KEY = 'discover:ver';

@Injectable()
export class DiscoverCacheService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private async version(): Promise<number> {
    const raw = await this.redis.get(VERSION_KEY);
    return raw ? Number(raw) : 0;
  }

  /**
   * 입력을 정규화한 뒤 안정 해시로 캐시 키를 만든다. 빈 category 와 빈 q 는 동일하게
   * 취급된다(discover 서비스의 cat/q 트림과 대칭). q 는 toLowerCase() 로 정규화해 SQL
   * ILIKE(대소문자 무시)와 대칭을 맞추고 적중률을 높인다(W16 fix-forward MEDIUM-2);
   * category 는 enum 값이라 트림만 한다.
   */
  async keyFor(input: DiscoverCacheKeyInput): Promise<string> {
    const ver = await this.version();
    const normalized = {
      category: (input.category ?? '').trim(),
      // S72 W16 fix-forward (MEDIUM-2): ILIKE 와 대칭 — "Rust"/"rust" 가 같은 키로 적중.
      q: (input.q ?? '').trim().toLowerCase(),
      cursor: input.cursor ?? '',
      limit: input.limit,
    };
    // S72 W16 fix-forward (MEDIUM-3): 충돌→오답 서빙 방지로 16→32자(비용 미미).
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32);
    return `discover:v${ver}:${hash}`;
  }

  /** MISS → null, HIT → 파싱된 payload. */
  async read<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  /** payload 를 DISCOVER_CACHE_TTL_SEC(60s) TTL 로 SET EX 한다. */
  async write(key: string, payload: unknown): Promise<void> {
    await this.redis.set(key, JSON.stringify(payload), 'EX', DISCOVER_CACHE_TTL_SEC);
  }

  /** 버전 키를 bump 해 이후 모든 discover 캐시 키를 새 네임스페이스로 옮긴다. */
  async invalidate(): Promise<void> {
    await this.redis.incr(VERSION_KEY);
  }
}
