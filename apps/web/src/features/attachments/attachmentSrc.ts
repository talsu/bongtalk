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
 * 첨부 프록시를 인증 fetch 해 objectURL 을 만든다. 호출자는 반환 url 을 더 이상
 * 쓰지 않을 때 revokeObjectURL 해야 한다(컴포넌트가 cleanup 에서 처리). thumbnail
 * 202(미완료)면 download 원본으로 1회 폴백한다.
 */
export async function fetchAttachmentObjectUrl(
  id: string,
  variant: ProxyVariant = 'download',
): Promise<string> {
  const res = await authedFetch(proxyPath(id, variant));
  // 썸네일 후처리 미완료(202): 원본으로 폴백.
  if (variant === 'thumbnail' && res.status === 202) {
    const orig = await authedFetch(proxyPath(id, 'download'));
    if (!orig.ok) throw new Error(`attachment ${orig.status}`);
    return URL.createObjectURL(await orig.blob());
  }
  if (!res.ok) throw new Error(`attachment ${res.status}`);
  return URL.createObjectURL(await res.blob());
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
    a.download = originalName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 브라우저가 다운로드를 시작할 시간을 준 뒤 revoke.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
