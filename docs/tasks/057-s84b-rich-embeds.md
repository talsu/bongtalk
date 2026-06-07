# 057 · S84b — 봇/웹훅 rich embed 배열 (FR-RC12)

> D16-richcontent 슬라이스 S84 3분할의 2번째: S84a=FR-RC11(완료·LIVE),
> **S84b = FR-RC12(rich embed 배열)**, S84c=FR-RC19(링크프리뷰 전역 비활성화).

## Context

PRD FR-RC12: 봇/웹훅 메시지에 embed 배열을 첨부할 수 있어야 한다. embed 필드:
color(hex), author(name+icon_url+url), title+url, description, fields(name+value+
inline, 최대 25개), thumbnail, image, footer, timestamp.

기반: S84a(FR-RC11) 인커밍 웹훅/봇 메시지 LIVE. 인커밍 payload 는 content/username/
avatar_url 만 받는다(embeds 는 본 슬라이스에서 추가). S60 의 `MessageEmbed`(링크
unfurl)는 url·cacheKey·siteName·imageProxyUrl·statusCode·suppressedAt 구조로 **비동기
unfurl 전용**이라 Discord 스타일 rich embed 와 형태·생명주기가 완전히 다르다.

## 아키텍처 결정 (Option A + Message JSON 컬럼)

- rich embed 는 웹훅 게시 시점에 payload 로 통째 제공되는 **불변** 데이터다(unfurl 처럼
  비동기 갱신·per-URL suppress 없음). 별도 `MessageRichEmbed` 테이블 + N+1 aggregation
  대신 `Message.richEmbeds Json?` 컬럼에 저장한다(`mentions`/`contentAst` JSON 선례 ·
  ≤10 embed × ≤25 field 로 bounded). read-path 는 JSON 컬럼만 SELECT 해 그대로 통과.
- MessageDto 에 `richEmbeds` 를 **optional** 로 추가(S84a 와 동일 — 기존 MessageDto 리터럴
  15+ 무회귀). 기존 unfurl `embeds[]` 와 별도 필드라 렌더가 분리된다.

## Scope

### IN

- **shared-types** `rich-embed.ts`: `RichEmbedSchema`(color hex 정규화 · author{name,
  iconUrl,url} · title+url · description · fields[≤25]{name,value,inline} · image ·
  thumbnail · footer{text,iconUrl} · timestamp) + `RichEmbedFieldSchema`. 모든 URL 은
  http(s)만(SSRF · S84a avatar 일관). 캡: title≤256 · description≤4096 · field.name≤256 ·
  field.value≤1024 · author.name≤256 · footer.text≤2048 · embeds≤10/메시지.
  `IncomingWebhookPayloadSchema` 에 `embeds?: RichEmbed[]` 추가. `MessageDtoSchema` +
  events.ts payload 에 `richEmbeds` optional 추가.
- **Prisma**: `Message.richEmbeds Json?` additive nullable 컬럼 + reversible 마이그레이션.
- **API**: `MessagesService.createBotMessage` 가 `richEmbeds` 받아 JSON 저장 + WS payload
  전파. `WebhooksService.verifyAndPost` 가 payload.embeds 를 정규화(color · 빈 embed
  제거)해 전달. `toDto` 가 richEmbeds 매핑 + rawList/thread-replies raw SELECT 에 컬럼 추가.
- **web**: `RichEmbed.tsx` — `.qf-embed` 기반 카드(color → border-left 인라인[content
  color · Avatar seed 선례] · author row · linked title · description · fields grid
  (inline 3열) · image/thumbnail · footer + timestamp). MessageItem 이 unfurl embeds
  뒤에 `msg.richEmbeds` 렌더. DS 4파일 미수정(Tailwind DS 토큰 유틸 합성).
- **tests**: shared-types Zod(캡/color/SSRF/fields≤25) · API 통합(웹훅 embed 게시 →
  저장·DTO·authorType BOT) · web RichEmbed 렌더 단위.

### OUT (non-goals)

- 링크프리뷰 전역 비활성화(FR-RC19 → S84c).
- 일반 사용자 메시지의 embed(웹훅/봇 전용 — Discord parity).
- embed 이미지 프록시/리사이즈(원격 URL 직접 · 서버 미디어 리사이즈 금지 일관).
- 웹훅 관리 UI.

## Acceptance Criteria (기계 검증)

- `pnpm verify`(node20 컨테이너) GREEN.
- 웹훅 POST 에 embeds 배열 → Message.richEmbeds 저장 + DTO.richEmbeds 노출 + authorType=BOT.
- color hex 정규화(`#RRGGBB`) · 비-http(s) URL 거부 · fields>25 거부 · embeds>10 거부.
- web: rich embed 카드가 color bar + title + fields 를 렌더(단위 테스트).

## Non-goals / Risks

- **보안**: 모든 embed URL http(s) scheme 제한(SSRF). 길이/개수 캡으로 payload 폭주 방지.
- JSON 컬럼: 비정규화라 embed 단위 쿼리 불가(전체 메시지 단위만) — FR-RC12 범위엔 충분.
- 마이그레이션 reversible(additive nullable · down DROP COLUMN).

## DoD

- 체크리스트 green + `pnpm verify` 로그 + reviewer(adversarial) 통과.
- fr-matrix FR-RC12 = done · 핸드오프/추적 갱신.
- 수동 배포(사용자 승인 후) — build-and-push + auto-deploy + /readyz.
