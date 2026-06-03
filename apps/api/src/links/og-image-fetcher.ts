import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ssrfGuard } from './ssrf-guard';
import { pinnedRequest, readBoundedBuffer } from './pinned-http';
import { S3Service } from '../storage/s3.service';

/**
 * S60 (D11 / FR-AM-14/15 · FR-RC21): OG 이미지 fetch + MinIO 캐시.
 *
 * unfurl 카드의 이미지를 백엔드가 fetch 해 MinIO 에 저장하고, 그 object key 를
 * MessageEmbed.imageKey 로 돌려준다. presigned URL 직접 노출 대신 /links/embed-image/:id
 * 프록시 뒤에서만 서빙하기 위함이다(FR-RC21).
 *
 * SSRF 방어(og-parser/ssrf-guard 와 동일 강도 · DNS rebinding 차단):
 *   - 각 hop(원본 + redirect)마다 ssrfGuard 로 host → IP 검증(사설/loopback/link-local/
 *     메타데이터 169.254.169.254 차단).
 *   - **소켓 레벨 IP 핀**: 검증한 IP 로 직접 connect 하고 Host 헤더에 원래 hostname 을
 *     실어 보낸다(DNS TTL 무시 — 검증과 connect 사이 DNS 가 바뀌어도(rebinding) 우리가
 *     connect 한 IP 는 검증된 IP 다). https 는 servername(SNI)에도 원래 hostname 을 둔다.
 *   - redirect 상한 5회 · 타임아웃 5s · 응답 크기 상한(MAX_IMAGE_BYTES).
 *   - Content-Type 이 image/* 가 아니면 저장 거부(svg+xml 은 stored-XSS 위험이라 제외).
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const USER_AGENT = 'qufox-link-preview/1.0 (+https://qufox.com)';

// 저장 허용 이미지 MIME → 확장자. image/svg+xml 은 인라인 스크립트 실행 위험이라 제외한다.
// S60 fix (security MEDIUM-2): embed-image 프록시가 스트리밍 전 저장된 contentType 을
// 이 허용목록과 재대조하므로 export 한다(과거 잘못 저장된 MIME 방어).
export const ALLOWED_IMAGE_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

export interface FetchedOgImage {
  /** MinIO object key. */
  imageKey: string;
  mime: string;
  sizeBytes: number;
}

@Injectable()
export class OgImageFetcher {
  private readonly logger = new Logger(OgImageFetcher.name);

  constructor(private readonly s3: S3Service) {}

  /**
   * OG 이미지 URL 을 fetch → image/* 검증 → MinIO 저장. 성공 시 FetchedOgImage, 실패
   * (SSRF reject / 비-image / 크기 초과 / 네트워크 오류)는 null 을 돌려준다(이미지 없는
   * 카드로 graceful degrade — throw 하지 않는다).
   */
  async fetchAndStore(rawImageUrl: string): Promise<FetchedOgImage | null> {
    let body: { bytes: Uint8Array; mime: string } | null;
    try {
      body = await this.fetchImageBytes(rawImageUrl);
    } catch (err) {
      this.logger.warn(
        `[unfurl] og-image fetch error url=${rawImageUrl.slice(0, 200)} err=${String(err).slice(0, 160)}`,
      );
      return null;
    }
    if (!body) return null;
    const ext = ALLOWED_IMAGE_MIME[body.mime.toLowerCase()];
    if (!ext) {
      // image/* 이 아니거나 허용 목록 밖(svg 등) → 저장 거부.
      return null;
    }
    // 결정적 object key: 정규화 전 URL 의 sha256(콘텐츠 주소화 아님 — URL 주소화)으로
    // 동일 이미지의 중복 저장을 줄인다(같은 URL 재unfurl 시 동일 key 로 덮어쓰기).
    const hash = createHash('sha256').update(rawImageUrl).digest('hex');
    const imageKey = `link-embeds/${hash}.${ext}`;
    try {
      await this.s3.putObject(imageKey, body.bytes, body.mime);
    } catch (err) {
      this.logger.warn(
        `[unfurl] og-image MinIO put failed key=${imageKey} err=${String(err).slice(0, 160)}`,
      );
      return null;
    }
    return { imageKey, mime: body.mime, sizeBytes: body.bytes.byteLength };
  }

  /**
   * 각 hop ssrfGuard 재검증 + IP 핀 connect 로 이미지 바이트를 받는다. 비-image/*,
   * 크기 초과, redirect 5회 초과, 타임아웃은 null/throw 로 신호한다.
   *
   * `protected` 인 이유: 단위 테스트가 외부 네트워크 I/O 를 서브클래스로 stub 하기
   * 위함이다(실제 소켓 연결을 단위 테스트에서 띄우지 않는다 — int/런타임에서 검증).
   */
  protected async fetchImageBytes(
    startUrl: string,
  ): Promise<{ bytes: Uint8Array; mime: string } | null> {
    let current = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const guard = await ssrfGuard(current);
      if (!guard.ok) {
        throw new Error(`ssrf-guard rejected image target: ${guard.reason}`);
      }
      // 검증된 IP 로 직접 connect(IP 핀 — DNS rebinding TOCTOU 차단 · pinned-http 공유).
      const res = await pinnedRequest({
        url: guard.url,
        ip: guard.resolvedIp,
        family: guard.family,
        timeoutMs: FETCH_TIMEOUT_MS,
        headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
      });
      const status = res.statusCode ?? 0;
      // redirect 처리(3xx + location). 각 hop 다시 ssrfGuard 재검증된다.
      if (status >= 300 && status < 400) {
        const loc = res.headers.location;
        res.resume(); // body 소진(소켓 해제).
        if (!loc) return null;
        try {
          current = new URL(loc, current).toString();
        } catch {
          return null;
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return null;
      }
      const mime = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!mime.startsWith('image/')) {
        res.resume();
        return null;
      }
      // Content-Length 선검사(있으면) — 상한 초과면 즉시 중단.
      const declared = Number(res.headers['content-length'] ?? '');
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        res.destroy();
        return null;
      }
      const bytes = await readBoundedBuffer(res, MAX_IMAGE_BYTES);
      if (bytes === null) return null;
      return { bytes, mime };
    }
    throw new Error('too many redirects');
  }
}
