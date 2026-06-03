import { z } from 'zod';
import { MRKDWN_PARSE_LIMITS } from './mrkdwn';

/**
 * S60 (D11 / FR-RC07/09 · FR-AM-15): 링크 unfurl 계약 + URL 정규화.
 *
 * `normalizeUrl()` 는 BE UnfurlProcessor(캐시 키 산정)와 계약 검증이 동일한 규칙을
 * 쓰도록 shared-types 에 둔 **순수 함수**다. 정규화 규칙(FR-RC07):
 *   - scheme + host 를 소문자로(path/query 는 대소문자 보존 — 라우팅에 유의미할 수 있음)
 *   - 추적 파라미터(utm_*, fbclid, gclid) 제거
 *   - trailing slash 제거(루트 '/' 는 보존 — 빈 path 와 구분)
 *   - fragment(#...) 제거(서버 fetch 에 무의미)
 *   - 기본 포트(http:80 / https:443) 제거
 *
 * 정규화 실패(파싱 불가/비-http(s))는 입력을 그대로(trim) 돌려준다 — 호출자(ssrfGuard)
 * 가 비-http(s) 를 다시 거부하므로 여기서 throw 하지 않는다(캐시 키 산정 단계에서
 * 예외를 던지면 fire-and-forget 워커가 중단될 수 있어 보수적으로 통과시킨다).
 */
const TRACKING_PARAM_PREFIXES = ['utm_'] as const;
const TRACKING_PARAM_EXACT = new Set(['fbclid', 'gclid']);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return trimmed;
  }
  // scheme + host 소문자(WHATWG URL 은 protocol/hostname 을 이미 소문자로 둔다 —
  // 명시적 재보장으로 의도를 드러낸다). userinfo 는 ssrfGuard 가 별도로 거부하므로
  // 여기서 보존해도 무해하지만, 캐시 키 안정성을 위해 제거한다.
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase();
  u.protocol = u.protocol.toLowerCase();
  // fragment 제거(서버 fetch 에 무의미하고 캐시 키만 분산시킨다).
  u.hash = '';
  // 기본 포트 제거(WHATWG URL 은 80/443 을 이미 비우지만 명시).
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }
  // 추적 파라미터 제거(키 순서는 보존 — 원본 의미를 최대한 유지).
  const toDelete: string[] = [];
  u.searchParams.forEach((_v, key) => {
    if (isTrackingParam(key)) toDelete.push(key);
  });
  for (const key of toDelete) u.searchParams.delete(key);
  // searchParams 가 비면 '?' 자체를 떨군다.
  let out = u.toString();
  // trailing '?' 제거(쿼리가 모두 제거된 경우 WHATWG 가 '?' 를 남기지 않지만 방어).
  out = out.replace(/\?$/, '');
  // trailing slash 제거(단, scheme://host/ 의 루트 '/' 는 보존 — pathname==='/').
  if (u.pathname !== '/' && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * S60 (FR-RC07): 메시지당 unfurl 시도 상한. FE extractMessageUrls 의
 * LINK_PREVIEW_CAP_PER_MESSAGE 와 동일 값으로 둔다(서버가 권위적 cap).
 */
export const LINK_UNFURL_CAP_PER_MESSAGE = 3;

// S60 (FR-AM-16 · FR-RC08): URL 추출 정규식 + 마스킹 패턴. FE parseContent.tsx 의
// extractMessageUrls 와 **동일** 규칙을 shared-types 에 단일 정의해 BE 워커 enqueue 와
// FE 렌더가 같은 URL 집합을 보게 한다(drift 방지). 핵심:
//   - http(s) 만 · trailing punct 보호 · `[^\s<>]` 라 꺾쇠(`<URL>`)는 매치를 끊는다
//     (= 꺾쇠 감싼 URL 은 unfurl 스킵 — FR-AM-16/RC08).
//   - fenced(```...```)/inline(`...`) 코드 영역은 공백 마스킹해 그 안의 URL 제외.
//   - quote prefix(`> `)는 강조 무관이라 제거하되 본문 URL 은 유지.
//   - cap 3(LINK_UNFURL_CAP_PER_MESSAGE) · dedupe.
const UNFURL_URL_RE = /(https?:\/\/[^\s<>]+[^\s<>.,;:!?'"()\]])/g;
const UNFURL_FENCE_RE = /```[\s\S]*?```/g;
const UNFURL_INLINE_CODE_RE = /`[^`\n]+`/g;
const UNFURL_QUOTE_LINE_RE = /^>\s?/;
// FR-AM-16/RC08: 꺾쇠로 감싼 URL(`<https://...>`)은 명시적 suppress 의도다. 감싼 토큰
// 전체를 공백 마스킹해 그 안의 URL 이 추출되지 않게 한다(Discord/Slack parity).
const UNFURL_ANGLE_WRAPPED_RE = /<https?:\/\/[^\s<>]+>/g;

/**
 * S60 (FR-RC07/08 · FR-AM-16): 메시지 본문에서 unfurl 대상 URL 을 추출한다(순수 함수 ·
 * BE 워커 enqueue + FE 렌더 공유). 꺾쇠(`<URL>`) 감싼 URL · 코드블록 내부 URL 은 제외하고,
 * 메시지당 최대 LINK_UNFURL_CAP_PER_MESSAGE(3)개를 dedupe 해 돌려준다.
 */
export function extractUnfurlUrls(content: string): string[] {
  if (!content) return [];
  // 백트래킹 worst-case 차단 — MAX_PLAIN_LENGTH 로 먼저 bound(서버가 enforce 하므로
  // 정상 데이터는 무영향).
  const bounded =
    content.length > MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH
      ? content.slice(0, MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH)
      : content;
  const masked = bounded
    .replace(UNFURL_FENCE_RE, (m) => ' '.repeat(m.length))
    .replace(UNFURL_INLINE_CODE_RE, (m) => ' '.repeat(m.length))
    // 꺾쇠 감싼 URL 전체를 마스킹(suppress) — 그 안의 URL 은 추출 대상에서 제외.
    .replace(UNFURL_ANGLE_WRAPPED_RE, (m) => ' '.repeat(m.length))
    .split('\n')
    .map((line) =>
      UNFURL_QUOTE_LINE_RE.test(line) ? line.replace(UNFURL_QUOTE_LINE_RE, '') : line,
    )
    .join('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of masked.matchAll(UNFURL_URL_RE)) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= LINK_UNFURL_CAP_PER_MESSAGE) break;
  }
  return out;
}

/**
 * S60 (FR-RC07/21): 메시지 embed(unfurl 카드) 와이어 DTO.
 *
 * - title/description/siteName 은 메타 부재 시 null.
 * - imageProxyUrl 은 OG 이미지가 MinIO 에 캐시된 경우에만 채워진다 — 항상 백엔드
 *   프록시 경로(`/links/embed-image/:id`)이며 presigned URL 을 직접 노출하지 않는다
 *   (FR-RC21). 이미지 없으면 null.
 * - suppressedAt 이 있으면 사후 억제된 embed 다. read-path 는 suppressedAt IS NULL
 *   만 내려보내므로 정상 응답에서는 항상 null 이지만, 와이어 forward-compat 을 위해
 *   nullable 필드로 명시한다(클라가 hide 판정에 쓸 수 있음).
 */
export const MessageEmbedDtoSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  siteName: z.string().nullable().default(null),
  imageProxyUrl: z.string().nullable().default(null),
  suppressedAt: z.string().datetime().nullable().default(null),
});
export type MessageEmbedDto = z.infer<typeof MessageEmbedDtoSchema>;
