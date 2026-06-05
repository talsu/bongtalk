import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { GiphySearchResponse } from '@qufox/shared-types';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S81b (D15 / FR-SC-07) — GIPHY Search API 서버 프록시.
 *
 * `/giphy [키워드]` 실행과 프리뷰 Shuffle 이 이 서비스를 통해 GIF 한 개를 받는다. API 키는
 * 서버 env(GIPHY_API_KEY)에서만 읽고 절대 클라이언트로 노출하지 않는다(서버가 호출 URL 에
 * 붙임). 호출 대상 호스트는 고정(api.giphy.com)이라 SSRF 무관 — 평범한 fetch 로 충분하다.
 *
 * env-gate(NAS 기본 비활성): GIPHY_API_KEY 미설정이면 외부 호출을 시도조차 하지 않고
 * GIPHY_UNAVAILABLE(503) 로 graceful 거부한다(ENCRYPTION_UNAVAILABLE 2FA 선례 동일 —
 * prod 는 키 미설정이라 inert, 절대 500/크래시 금지). GIPHY 자체 오류·타임아웃·형식 위반도
 * 같은 코드로 흡수한다. 단, 키워드 결과 0건은 GIPHY 가 정상 응답한 것이므로 에러가 아니라
 * null 을 돌려주고(호출부가 "결과 없음" EPHEMERAL 로 분기), 캐시하지 않는다.
 *
 * 캐시: `giphy:{정규화키워드}:{offset}` TTL 300s. HTTP 경계(GiphyFetch)와 키 공급자는
 * 생성자 주입이라 단위 테스트에서 vi.fn() 으로 모킹한다(외부 모킹 라이브러리 불요).
 */

const GIPHY_SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const CACHE_TTL_SEC = 300;
const FETCH_TIMEOUT_MS = 5000;
// GIPHY 추천 rating 상한 — pg-13(약한 비속어/암시까지 허용, 노골적 콘텐츠 제외).
const RATING = 'pg-13';

/** HTTP 경계 — 단위 테스트에서 주입 가능하도록 최소 fetch 시그니처만 추상화한다. */
export type GiphyFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
export type GiphyFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<GiphyFetchResponse>;

/** GIPHY_API_KEY 공급자(env 읽기) — 테스트에서 결정적 키를 주입한다. */
export type GiphyKeyProvider = () => string | undefined;

/** DI 토큰 — fetch 경계와 키 공급자를 모듈에서 명시적으로 제공한다. */
export const GIPHY_FETCH = Symbol('GIPHY_FETCH');
export const GIPHY_KEY_PROVIDER = Symbol('GIPHY_KEY_PROVIDER');

@Injectable()
export class GiphyProxyService {
  private readonly logger = new Logger(GiphyProxyService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(GIPHY_FETCH) private readonly fetchImpl: GiphyFetch,
    @Inject(GIPHY_KEY_PROVIDER) private readonly keyProvider: GiphyKeyProvider,
  ) {}

  /** GIPHY_API_KEY 가 설정돼 있으면 true. 컨트롤러/실행기가 env-gate 판정에 쓴다. */
  isEnabled(): boolean {
    return this.resolveKey() !== null;
  }

  /**
   * 키워드 + offset 으로 GIF 한 개를 검색한다. 캐시 hit 면 즉시 반환, miss 면 GIPHY 호출
   * 후 캐시한다. 결과 0건이면 null(에러 아님 — "결과 없음" 분기). 키 미설정/GIPHY 오류/형식
   * 위반은 GIPHY_UNAVAILABLE(503) 을 던진다.
   */
  async search(keyword: string, offset: number): Promise<GiphySearchResponse | null> {
    const apiKey = this.resolveKey();
    if (apiKey === null) {
      throw new DomainError(ErrorCode.GIPHY_UNAVAILABLE, 'GIPHY 가 설정되지 않았습니다');
    }
    const normalizedKeyword = keyword.trim().toLowerCase();
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const cacheKey = `giphy:${normalizedKeyword}:${safeOffset}`;

    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const body = await this.callGiphy(apiKey, normalizedKeyword, safeOffset);
    const parsed = this.extractFirst(body);
    // 결과 0건 → null(캐시하지 않음 — 다음 시도에 다른 결과가 있을 수 있음).
    if (parsed === null) return null;
    await this.writeCache(cacheKey, parsed);
    return parsed;
  }

  /** GIPHY_API_KEY env 를 trim 해 비어 있지 않으면 반환, 아니면 null. */
  private resolveKey(): string | null {
    const raw = (this.keyProvider() ?? '').trim();
    return raw.length > 0 ? raw : null;
  }

  /** GIPHY Search API 를 호출한다. 비-2xx / 네트워크 오류는 GIPHY_UNAVAILABLE 로 변환한다. */
  private async callGiphy(apiKey: string, keyword: string, offset: number): Promise<unknown> {
    const url =
      `${GIPHY_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}` +
      `&q=${encodeURIComponent(keyword)}&limit=1&offset=${offset}&rating=${RATING}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        this.logger.warn({ status: res.status, keyword }, 'GIPHY search non-2xx');
        throw new DomainError(ErrorCode.GIPHY_UNAVAILABLE, 'GIF 를 가져오지 못했습니다');
      }
      return await res.json();
    } catch (err) {
      // DomainError(위 비-2xx)는 그대로 전파, 그 외(네트워크/abort/json 파싱)는 흡수해 변환.
      if (err instanceof DomainError) throw err;
      const msg = err instanceof Error ? err.message : 'giphy fetch failed';
      this.logger.warn({ keyword, err: msg }, 'GIPHY search fetch error');
      throw new DomainError(ErrorCode.GIPHY_UNAVAILABLE, 'GIF 를 가져오지 못했습니다');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GIPHY 응답에서 첫 GIF 의 url/thumb/title 을 추출한다. data 가 비면 null(결과 없음).
   * 필수 URL(original/fixed_width)이 누락된 깨진 형식은 GIPHY_UNAVAILABLE 로 거부한다.
   */
  private extractFirst(body: unknown): GiphySearchResponse | null {
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as {
      title?: unknown;
      images?: {
        original?: { url?: unknown };
        fixed_width?: { url?: unknown };
      };
    };
    const gifUrl = first?.images?.original?.url;
    const gifThumbUrl = first?.images?.fixed_width?.url;
    if (typeof gifUrl !== 'string' || typeof gifThumbUrl !== 'string') {
      this.logger.warn('GIPHY search response missing image urls');
      throw new DomainError(ErrorCode.GIPHY_UNAVAILABLE, 'GIF 응답 형식이 올바르지 않습니다');
    }
    return {
      gifUrl,
      gifThumbUrl,
      title: typeof first.title === 'string' ? first.title : '',
    };
  }

  private async readCache(key: string): Promise<GiphySearchResponse | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as GiphySearchResponse;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: GiphySearchResponse): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SEC);
    } catch {
      // best-effort — 캐시 실패는 무해(다음 호출에 재시도).
    }
  }
}
