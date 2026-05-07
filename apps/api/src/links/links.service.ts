import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { ssrfGuard, type SsrfRejectReason } from './ssrf-guard';
import { parseOgMetadata } from './og-parser';

/**
 * task-045 iter2: link unfurl service.
 *
 * Flow:
 *  1. SSRF guard 검증 (사설 IP / file:// scheme / userinfo 차단)
 *  2. Redis 캐시 조회 — hit 면 그대로 반환
 *  3. fetch (timeout 5s, max 256KB, max-redirect 3)
 *  4. HTML 파싱 → og:* + fallback
 *  5. Redis 캐시 저장 (성공 1h, 실패 60s)
 */

const CACHE_TTL_OK_SEC = 60 * 60; // 1h
const CACHE_TTL_FAIL_SEC = 60; // 1min
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256 * 1024; // 256KB
const MAX_REDIRECTS = 3;
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
    const guard = await ssrfGuard(rawUrl);
    if (!guard.ok) {
      throw this.toGuardError(guard.reason);
    }
    const normalized = guard.url.toString();
    const cacheKey = this.cacheKey(normalized);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as LinkPreview;
      } catch {
        // corrupt cache — fall through to refetch.
      }
    }
    const preview = await this.fetchAndParse(normalized);
    const ttl =
      preview.statusCode >= 200 && preview.statusCode < 300 ? CACHE_TTL_OK_SEC : CACHE_TTL_FAIL_SEC;
    await this.redis.set(cacheKey, JSON.stringify(preview), 'EX', ttl);
    return preview;
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

  private async fetchAndParse(url: string): Promise<LinkPreview> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      // Node 20 native fetch — redirect 'follow' 이 max 20 까지라 명시적
      // 제한 위해 manual 처리 X 하고 native 의 redirect:'follow' 허용.
      // SSRF guard 는 첫 hostname 만 검증하므로 redirect 가 사설 IP 로
      // 가는 위험은 남음 — 그래서 redirect 한 번에 최대 3, 그리고 매
      // step 마다 SSRF 재검증을 위해 manual loop 가 더 안전합니다.
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
    return {
      url,
      title: og.title,
      description: og.description,
      image: og.image,
      siteName: og.siteName ?? host,
      statusCode: status,
      fetchedAt: new Date().toISOString(),
    };
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
