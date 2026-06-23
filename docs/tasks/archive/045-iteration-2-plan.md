# Iteration 2 — PLAN

## Scope

Link unfurl / OpenGraph 임베드 — BE scraper + SSRF guard + Redis cache + FE `.qf-embed` 카드.

## (A) BE — SSRF-safe OG scraper

### 신규 모듈: `apps/api/src/links/`

```
apps/api/src/links/
├── links.module.ts
├── links.controller.ts          (GET /links/preview)
├── links.service.ts             (orchestrator)
├── ssrf-guard.ts                (URL → IP 검증)
├── og-parser.ts                 (HTML → og:* 추출)
└── types.ts                     (LinkPreview type)
```

### SSRF guard 룰

**차단 대상**:

- non-`http(s)` scheme
- userinfo 포함 URL (`http://user@host`)
- localhost / 127.x.x.x / ::1
- 사설 IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
- 사설 IPv6: fc00::/7, fe80::/10, ::ffff:0:0/96 (mapped IPv4 → 검증 통과해야 함)
- DNS resolution 결과의 모든 IP 검증 (다중 A 레코드 모두 검증)

**검증 흐름**:

1. URL parse → scheme/userinfo 검증
2. host 가 IP literal 이면 직접 검증
3. host 가 도메인이면 `dns.lookup(host, { all: true })` 로 모든 IP 추출 → 각각 검증
4. 통과한 첫 IP 를 fetch 의 host 로 강제 (DNS rebinding 차단)

### Fetch 정책

- timeout 5s
- max body size 256KB (HTML 헤더 부분만 필요)
- max redirect 3
- User-Agent: `qufox-link-preview/1.0`
- Accept: `text/html,application/xhtml+xml`
- Cancel & abort 시 partial body 폐기

### OG parser

- `cheerio` 또는 `node-html-parser` 중 lighter 한 것 선택
- 추출: `<meta property="og:title">`, `og:description`, `og:image`, `og:site_name`, `og:url`
- fallback: `<title>` / `<meta name="description">` / `<link rel="icon">`

### Cache (Redis)

- key: `linkpreview:<sha256(url)>`
- TTL: 1시간 (3600s)
- value: JSON `{ ogTitle, ogDescription, ogImage, ogSiteName, ogUrl, statusCode, fetchedAt }`
- 실패도 짧게 캐시 (TTL 60s) — 같은 URL 반복 요청 부하 차단

### Endpoint

```
GET /links/preview?url=<encoded>

Response 200: {
  url: string,
  title: string | null,
  description: string | null,
  image: string | null,
  siteName: string | null,
  statusCode: number,
  fetchedAt: ISO string
}

Response 4xx:
  400 INVALID_URL — SSRF guard 차단
  413 PAYLOAD_TOO_LARGE — body > 256KB
  504 LINK_PREVIEW_TIMEOUT — fetch timeout
```

### Auth

- JWT 인증 필수 (rate limit 적용 — sender 가 무한 fetch 못 하게)
- per-user rate: 60/min (composer 입력 중 빠르게 입력해도 충분)

## (B) FE — `.qf-embed` 카드 렌더

### 변경

- `parseContent.tsx`: URL 토큰을 렌더할 때 그냥 `<a>` 만이 아니라, `LinkPreview` 컴포넌트로 wrap (lazy-fetch)
- 신규 `apps/web/src/features/messages/LinkPreview.tsx`:
  - props: `url: string`
  - useQuery 로 GET /links/preview?url= 호출
  - 응답 도착 시 `.qf-embed` 카드 렌더 (DS 클래스 그대로)
  - 실패 시 카드 hide (URL 만 표시)
- 다중 URL: 메시지당 최대 3개 카드 (Discord 정책 동일)

### Cache

- react-query staleTime 30분 (BE 캐시 TTL 1시간 보다 짧게 → 사용자가 새로고침해도 신선도 유지)

## DoD

- [ ] SSRF guard module + spec (private IP / scheme / DNS rebinding 모두 차단)
- [ ] OG parser + spec (og:\* 추출 + fallback)
- [ ] LinksService + Redis 캐시
- [ ] LinksController GET /links/preview
- [ ] Module registered in AppModule
- [ ] FE LinkPreview 컴포넌트
- [ ] parseContent 가 URL 을 LinkPreview 로 wrap (선택 — 시간 budget)
- [ ] `pnpm verify` green
- [ ] DS 4파일 md5 unchanged
- [ ] Visual baseline 보존 (BE only 변경은 영향 없음)
- [ ] develop merge → main auto-promote
- [ ] /readyz 200 + idle 30s
- [ ] pane 1 mini-progress

## Out of scope (이월)

- 첨부 이미지 직접 미리보기 (이미 `Attachment` 인프라 존재)
- 사용자 동의 / privacy mode (모든 메시지 URL 자동 fetch 동의 가정)
- Twitter/Slack 식 oEmbed: `TODO(task-045-follow-oembed)`
- 모바일 카드 layout 미세 조정: `TODO(task-045-follow-mobile-embed)`
- LinkPreview DB 영속화 (Redis 만): `TODO(task-045-follow-link-preview-db)`
