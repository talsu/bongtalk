import { getAccessToken } from '../../lib/api';

const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '/api';

/**
 * S56 (D11 / FR-AM-17/21) — 첨부 프록시 URL 빌더 + 인증 blob 페치.
 *
 * S55 프록시(`/attachments/:id/download` · `/attachments/:id/thumbnail`)는 매 요청
 * Bearer 토큰 + 채널 READ 재검증을 요구합니다(JwtAuthGuard 는 Authorization 헤더만
 * 추출 — 쿠키 미사용). 따라서 `<img src="/api/attachments/:id/download">` 처럼 토큰
 * 없는 직접 참조는 401 입니다. 대신 fetch 로 Authorization 헤더를 실어 받고(공개
 * 채널은 302→MinIO 리다이렉트를 fetch 가 자동 추종, 비공개 채널은 API 스트리밍),
 * Blob → objectURL 로 변환해 <img>/<audio> 의 src 로 씁니다.
 *
 * thumbnail 은 후처리 미완료 시 202 를 반환하므로(본문 비-이미지) 그 경우 download
 * 원본으로 폴백합니다.
 */

export type ProxyVariant = 'download' | 'thumbnail';

export function proxyPath(id: string, variant: ProxyVariant): string {
  return `/attachments/${id}/${variant}`;
}

/**
 * S56 fix-forward (perf CRITICAL — objectURL 채널 재진입 재fetch):
 *
 * MessageColumn 은 채널 전환마다 언마운트→재마운트되므로, 종전엔 컴포넌트
 * useEffect cleanup 이 매번 objectURL 을 revoke 하고 재마운트 시 모든 이미지를
 * 다시 인증 fetch 했습니다(50장이면 50회 재다운로드 — HTTP 캐시 우회). 동일
 * `id:variant` 의 objectURL 을 모듈 레벨 LRU 캐시에 보관해 재fetch 를 회피합니다.
 *
 *   - 캐시 hit → 즉시 기존 objectURL 반환(fetch 생략).
 *   - 캐시 miss → 1회만 fetch(동시요청 dedup: 진행 중 Promise 공유).
 *   - revoke 는 LRU eviction(상한 초과) 시에만 수행 — 컴포넌트 언마운트가 아니라
 *     캐시가 url 의 수명을 소유하므로, 소비자는 절대 revoke 하면 안 됩니다.
 */
const URL_CACHE_LIMIT = 100;
// 삽입 순서를 유지하는 Map = LRU(가장 오래된 = 첫 키). hit 시 재삽입으로 최신화.
const urlCache = new Map<string, string>();
// 동시 요청 dedup: 같은 key 의 in-flight fetch Promise 를 공유한다.
const inflight = new Map<string, Promise<string>>();

function cacheKey(id: string, variant: ProxyVariant): string {
  return `${id}:${variant}`;
}

/** LRU 갱신: 기존 키를 지우고 끝에 다시 넣어 "최근 사용"으로 만든다. */
function touch(key: string, url: string): void {
  urlCache.delete(key);
  urlCache.set(key, url);
  // 상한 초과 시 가장 오래된 항목(첫 키)을 evict + revoke.
  while (urlCache.size > URL_CACHE_LIMIT) {
    const oldestKey = urlCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldestUrl = urlCache.get(oldestKey);
    urlCache.delete(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
  }
}

/** 테스트 격리용 — 캐시/inflight 비우기(objectURL revoke 포함). */
export function __resetAttachmentUrlCache(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  inflight.clear();
}

/**
 * 첨부 프록시를 인증 fetch 해 objectURL 을 만든다. 모듈 LRU 캐시로 동일
 * `id:variant` 재fetch 를 회피하며, 반환 objectURL 의 수명은 캐시가 소유한다
 * (소비자는 revoke 하지 말 것 — LRU eviction 시에만 revoke). thumbnail 202
 * (미완료)면 download 원본으로 1회 폴백한다.
 */
export async function fetchAttachmentObjectUrl(
  id: string,
  variant: ProxyVariant = 'download',
): Promise<string> {
  const key = cacheKey(id, variant);
  const cached = urlCache.get(key);
  if (cached) {
    touch(key, cached); // LRU 최신화.
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<string> => {
    const res = await authedFetch(proxyPath(id, variant));
    // 썸네일 후처리 미완료(202): 원본으로 폴백.
    if (variant === 'thumbnail' && res.status === 202) {
      const orig = await authedFetch(proxyPath(id, 'download'));
      if (!orig.ok) throw new Error(`attachment ${orig.status}`);
      return URL.createObjectURL(await orig.blob());
    }
    if (!res.ok) throw new Error(`attachment ${res.status}`);
    return URL.createObjectURL(await res.blob());
  })();

  inflight.set(key, task);
  try {
    const url = await task;
    touch(key, url);
    return url;
  } finally {
    inflight.delete(key);
  }
}

async function authedFetch(path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  // credentials:include 로 쿠키도 동봉(향후 쿠키 인증 대비) — 현 가드는 Bearer 우선.
  return fetch(`${API_BASE}${path}`, { headers, credentials: 'include' });
}

/**
 * FILE 다운로드 클릭: 인증 fetch → blob → 임시 <a download> 클릭으로 저장.
 * `<a href=proxy>` 직접 클릭은 토큰이 안 실려 401 이므로 blob 경유한다.
 */
export async function downloadAttachment(id: string, originalName: string): Promise<void> {
  const res = await authedFetch(proxyPath(id, 'download'));
  if (!res.ok) throw new Error(`download ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = url;
    // S56 fix-forward (security LOW): 경로 구분자(`/`, `\`)를 `_` 로 치환해
    // download 속성이 디렉터리 트래버설로 해석될 여지를 차단한다(방어적).
    a.download = originalName.replace(/[/\\]/g, '_');
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 브라우저가 다운로드를 시작할 시간을 준 뒤 revoke.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
