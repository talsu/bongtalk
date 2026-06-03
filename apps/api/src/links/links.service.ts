import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { normalizeUrl } from '@qufox/shared-types';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { ssrfGuard, type SsrfRejectReason } from './ssrf-guard';
import { parseOgMetadata } from './og-parser';

/**
 * task-045 iter2: link unfurl service. S60 (D11 · FR-RC07/09 · FR-AM-15) 갱신.
 *
 * Flow:
 *  1. normalizeUrl() 로 추적 파라미터/trailing slash/대소문자 정규화
 *  2. SSRF guard 검증 (사설 IP / file:// scheme / userinfo 차단 · DNS rebinding 방어)
 *  3. Redis 캐시 조회(정규화 URL sha256) — hit 면 그대로 반환
 *  4. fetch (timeout 5s, max 256KB, max-redirect 5 · 각 hop SSRF 재검증)
 *  5. HTML 파싱 → og:* + Twitter Card + HTML fallback
 *  6. Redis 캐시 저장 (성공 1800s, 실패 60s)
 *
 * S60: REST lazy 경로(getPreview)와 BullMQ UnfurlProcessor 가 fetchAndParse·캐시 키
 * 산정을 공유한다. 캐시 키는 normalizeUrl() 결과의 sha256 으로 통일해 동일 URL 의
 * 추적 파라미터 변종이 같은 캐시를 공유하게 한다(FR-RC07/09).
 */

// S60 (FR-RC09): 성공 unfurl 결과 Redis TTL 1800s(=30m). 기존 3600s 에서 축소.
const CACHE_TTL_OK_SEC = 1800; // 30m
const CACHE_TTL_FAIL_SEC = 60; // 1min
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256 * 1024; // 256KB
// S60 (FR-AM-14): redirect 상한 5회(기존 3). 각 hop 마다 ssrfGuard 재검증.
const MAX_REDIRECTS = 5;
const USER_AGENT = 'qufox-link-preview/1.0 (+https://qufox.com)';

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  statusCode: number;
  fetchedAt: string;
};

@Injectable()
export class LinksService {
  private readonly logger = new Logger(LinksService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * URL 의 link preview 를 조회 / 가져오기. 캐시 hit 면 즉시 반환.
   * 실패 시 DomainError 또는 null preview 반환 (status 4xx/5xx 는
   * preview.statusCode 에 반영해 caller 가 hide 결정 가능).
   */
  async getPreview(rawUrl: string): Promise<LinkPreview> {
    // S60 (FR-RC07): 추적 파라미터/trailing slash/대소문자 정규화 후 SSRF 검증한다.
    const normalized = normalizeUrl(rawUrl);
    const guard = await ssrfGuard(normalized);
    if (!guard.ok) {
      throw this.toGuardError(guard.reason);
    }
    const target = guard.url.toString();
    const cacheKey = this.cacheKey(normalized);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as LinkPreview;
      } catch {
        // corrupt cache — fall through to refetch.
      }
    }
    const preview = await this.fetchAndParse(target);
    await this.cachePreview(normalized, preview);
    return preview;
  }

  /**
   * S60 (FR-RC07/09): normalizeUrl() 결과의 sha256(64 hex)을 캐시 키 + DB cacheKey 로
   * 쓴다. REST 경로(getPreview)는 32자 슬라이스 키(`linkpreview:`)를 그대로 유지하고,
   * 워커/DB 는 전체 64 hex(`embedCacheKey`)를 쓴다 — 두 경로를 한 곳에서 산정한다.
   */
  embedCacheKey(rawUrl: string): string {
    return createHash('sha256').update(normalizeUrl(rawUrl)).digest('hex');
  }

  /**
   * S60: UnfurlProcessor 가 캐시 키(64 hex sha256)로 Redis 캐시를 조회한다. hit 면
   * 파싱된 LinkPreview, miss 면 null. 손상된 캐시는 null(refetch 유도).
   */
  async getCachedByKey(cacheKey64: string): Promise<LinkPreview | null> {
    const cached = await this.redis.get(`linkembed:${cacheKey64}`);
    if (!cached) return null;
    try {
      return JSON.parse(cached) as LinkPreview;
    } catch {
      return null;
    }
  }

  /**
   * S60: 정규화 URL 의 fetch+parse 결과를 Redis 에 캐시한다(REST 키 + 워커 키 동시).
   * 성공(2xx)은 1800s, 실패는 60s. 워커는 fetchAndParse 결과를 이 메서드로 적재한다.
   */
  async cachePreview(normalizedUrl: string, preview: LinkPreview): Promise<void> {
    const ttl =
      preview.statusCode >= 200 && preview.statusCode < 300 ? CACHE_TTL_OK_SEC : CACHE_TTL_FAIL_SEC;
    const payload = JSON.stringify(preview);
    const key64 = createHash('sha256').update(normalizedUrl).digest('hex');
    await Promise.all([
      this.redis.set(this.cacheKey(normalizedUrl), payload, 'EX', ttl),
      this.redis.set(`linkembed:${key64}`, payload, 'EX', ttl),
    ]);
  }

  private cacheKey(url: string): string {
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 32);
    return `linkpreview:${hash}`;
  }

  private toGuardError(reason: SsrfRejectReason): DomainError {
    const map: Record<SsrfRejectReason, string> = {
      invalid_url: 'URL 형식이 올바르지 않습니다',
      unsupported_scheme: 'http(s) 만 지원합니다',
      userinfo_present: 'URL 에 userinfo 가 포함될 수 없습니다',
      private_ip: '내부 / 사설 주소는 미리보기를 제공하지 않습니다',
      dns_resolution_failed: 'DNS 조회 실패',
    };
    return new DomainError(ErrorCode.VALIDATION_FAILED, map[reason]);
  }

  /**
   * S60: 정규화·SSRF 검증을 마친 URL 을 fetch + 파싱해 LinkPreview 를 돌려준다. REST
   * 경로(getPreview)와 UnfurlProcessor 가 공유한다(public). 캐시 적재/조회는 호출자가
   * 담당한다(이 메서드는 순수 fetch+parse).
   */
  async fetchAndParse(url: string): Promise<LinkPreview> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      // S60 (FR-AM-14): native fetch 의 redirect:'follow'(max 20)를 쓰지 않고 manual
      // loop 로 각 hop 마다 ssrfGuard 를 재검증한다(redirect 가 사설 IP 로 점프하는
      // DNS-rebinding/redirect-SSRF 차단). 상한 5회·5s 타임아웃.
      res = await this.followRedirects(url, controller.signal);
    } catch (e: unknown) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : 'fetch failed';
      this.logger.warn({ url, err: msg }, 'link preview fetch error');
      return this.emptyPreview(url, 0);
    }
    clearTimeout(timer);
    const status = res.status;
    if (!res.ok) {
      return this.emptyPreview(url, status);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('html')) {
      // 비-HTML (이미지, JSON, application/octet-stream) 은 파싱 불가.
      return this.emptyPreview(url, status);
    }
    const html = await this.readBoundedText(res);
    if (html === null) {
      return this.emptyPreview(url, status);
    }
    const og = parseOgMetadata(html);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    // S60: og:image 가 상대 URL 일 수 있으므로 최종 응답 URL(res.url, 없으면 요청 url)
    // 기준으로 절대화한다. 절대화 실패하면 null(이미지 없음 — 카드 텍스트는 유지).
    const image = this.resolveImageUrl(og.image, res.url || url);
    return {
      url,
      title: og.title,
      description: og.description,
      image,
      siteName: og.siteName ?? host,
      statusCode: status,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * S60: og:image 후보를 페이지 base URL 기준 절대 URL 로 정규화한다. 비-http(s)
   * (data:/javascript: 등)는 null 로 거부한다 — og-image-fetcher 가 다시 ssrfGuard +
   * image/* 검증을 하지만, 명백한 비안전 스킴은 여기서도 1차 차단한다.
   */
  private resolveImageUrl(image: string | null, baseUrl: string): string | null {
    if (!image) return null;
    try {
      const abs = new URL(image, baseUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
      return abs.toString();
    } catch {
      return null;
    }
  }

  private async followRedirects(url: string, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const guard = await ssrfGuard(current);
      if (!guard.ok) {
        throw new Error(`ssrf-guard rejected redirect target: ${guard.reason}`);
      }
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en;q=0.9,ko;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return res;
        try {
          current = new URL(loc, current).toString();
        } catch {
          return res;
        }
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  }

  private async readBoundedText(res: Response): Promise<string | null> {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        // 256KB 까지만 사용 — head section 은 거의 항상 그 안에 있음.
        chunks.push(value.subarray(0, value.byteLength - (total - MAX_BODY_BYTES)));
        break;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total > MAX_BODY_BYTES ? MAX_BODY_BYTES : total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }

  private emptyPreview(url: string, statusCode: number): LinkPreview {
    return {
      url,
      title: null,
      description: null,
      image: null,
      siteName: null,
      statusCode,
      fetchedAt: new Date().toISOString(),
    };
  }
}
