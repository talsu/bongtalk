import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ssrfGuard } from './ssrf-guard';

/**
 * S60 fix (security BLOCKER-1 / HIGH-3): SSRF DNS-rebinding TOCTOU 를 막는 공통 IP 핀
 * HTTP 클라이언트.
 *
 * ssrfGuard 가 host → IP 를 검증하더라도, 그 뒤 평범한 fetch()/http.request(host) 를
 * 호출하면 라이브러리가 DNS 를 **재조회**한다. 공격자가 DNS TTL=0 으로 검증 시점엔
 * 공인 IP 를, connect 시점엔 내부 IP 를 돌려주면(rebinding) 검증을 우회한다.
 *
 * 방어: ssrfGuard 가 반환한 **검증된 IP 로 직접 connect** 하고, Host 헤더 + SNI 에는
 * 원래 hostname 을 실어 보낸다. DNS 가 그 사이 바뀌어도 우리가 연결하는 IP 는 검증된
 * IP 다. og-image-fetcher(이미지 바이트)와 links.service(HTML fetch) 두 경로가 이
 * 모듈을 공유한다(중복 구현 제거).
 */

/** IP 핀 요청의 타임아웃(ms). 호출자가 hop 별로 동일 값을 쓴다. */
export interface PinnedRequestOptions {
  /** ssrfGuard 가 검증한 URL(파싱된 형태). */
  url: URL;
  /** ssrfGuard 가 검증한 connect 대상 IP. */
  ip: string;
  /** 검증된 IP family(4/6). IPv6 리터럴 대괄호 처리에 쓴다. */
  family: 4 | 6;
  /** 요청 타임아웃(ms). */
  timeoutMs: number;
  /** Accept / User-Agent 등 추가 헤더(Host 는 이 함수가 강제 설정). */
  headers: Record<string, string>;
  /** AbortSignal(HTML fetch 의 상위 타임아웃 등). 선택. */
  signal?: AbortSignal;
}

/**
 * 검증된 IP 로 직접 connect 하되 Host 헤더 + SNI 는 원래 hostname 으로 보낸다(IP 핀 —
 * DNS rebinding 차단). 응답 헤더 수신 시점의 IncomingMessage 를 resolve 한다(본문은
 * 호출자가 소비/소진한다).
 */
export function pinnedRequest(opts: PinnedRequestOptions): Promise<IncomingMessage> {
  const { url, ip, family, timeoutMs, headers, signal } = opts;
  return new Promise<IncomingMessage>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const host = url.hostname;
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const path = `${url.pathname}${url.search}`;
    // IPv6 리터럴은 대괄호로 감싼다.
    const connectHost = family === 6 && isIP(ip) === 6 ? `[${ip}]` : ip;
    const options = {
      host: connectHost,
      port,
      path,
      method: 'GET',
      // Host 헤더는 원래 hostname(가상호스트 라우팅 + 검증 일관성).
      headers: {
        ...headers,
        host: url.port ? `${host}:${url.port}` : host,
      },
      // https: SNI 를 원래 hostname 으로(인증서 검증 일관). 검증된 IP 로 connect.
      ...(isHttps ? { servername: host } : {}),
      timeout: timeoutMs,
    };
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(options, (res) => resolve(res));
    const onAbort = (): void => {
      req.destroy(new Error('aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => {
      req.destroy(new Error('pinned request timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** redirect 따라가기 결과. body 는 IncomingMessage 로, 호출자가 bounded read 한다. */
export interface PinnedFollowResult {
  res: IncomingMessage;
  /** 최종(redirect 종료) 응답의 절대 URL. og:image 상대경로 절대화 base 로 쓴다. */
  finalUrl: string;
}

/**
 * 각 hop 마다 ssrfGuard 로 재검증한 뒤 IP 핀 connect 로 redirect 를 따라간다(최대
 * `maxRedirects` 회). 3xx + Location 이면 다음 hop 으로, 그 외엔 최종 응답을 돌려준다.
 * SSRF reject hop 은 throw 한다(호출자가 graceful degrade).
 *
 * og-image-fetcher 와 links.service 가 공유한다 — 단일 신뢰 경계.
 */
export async function followPinnedRedirects(params: {
  startUrl: string;
  maxRedirects: number;
  timeoutMs: number;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<PinnedFollowResult> {
  const { startUrl, maxRedirects, timeoutMs, headers, signal } = params;
  let current = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const guard = await ssrfGuard(current);
    if (!guard.ok) {
      throw new Error(`ssrf-guard rejected redirect target: ${guard.reason}`);
    }
    const res = await pinnedRequest({
      url: guard.url,
      ip: guard.resolvedIp,
      family: guard.family,
      timeoutMs,
      headers,
      signal,
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const loc = res.headers.location;
      res.resume(); // body 소진(소켓 해제).
      if (!loc) return { res, finalUrl: current };
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { res, finalUrl: current };
      }
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('too many redirects');
}

/**
 * IncomingMessage 의 본문을 `maxBytes` 까지만 읽어 Buffer 로 돌려준다. 초과하면 소켓을
 * 끊고 잘린 데이터를 돌려준다(HTML head 는 대개 앞쪽). `end` 없이 `close` 만 오면(전송
 * 중단) null 을 돌려준다 — 부분 응답을 정상 본문처럼 쓰지 않는다(LOW-1 `ended` 플래그).
 *
 * og-image(`null` = 거부)와 HTML(`null` = 카드 텍스트 없음) 모두 사용한다. Buffer 는
 * Uint8Array 의 하위 타입이라 추가 복사 없이 그대로 호출자에 전달한다(MEDIUM-3/LOW-1).
 */
export function readBoundedBuffer(res: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let ended = false;
    const finish = (val: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    res.on('data', (chunk: Buffer) => {
      if (settled) return;
      const remaining = maxBytes - total;
      if (chunk.byteLength >= remaining) {
        // 상한 도달 — 남은 만큼만 취하고 소켓을 끊는다.
        chunks.push(chunk.subarray(0, remaining));
        total = maxBytes;
        ended = true;
        res.destroy();
        finish(Buffer.concat(chunks));
        return;
      }
      total += chunk.byteLength;
      chunks.push(chunk);
    });
    res.on('end', () => {
      ended = true;
      finish(Buffer.concat(chunks));
    });
    res.on('error', () => finish(null));
    // `end` 없이 `close` 만 오면(연결 중단) 부분 데이터는 신뢰하지 않는다.
    res.on('close', () => finish(ended ? Buffer.concat(chunks) : null));
  });
}
