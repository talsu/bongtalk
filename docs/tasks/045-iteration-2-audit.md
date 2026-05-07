# Iteration 2 — AUDIT

## Score (시작)

- iter 1 종료 시 ≈ 87% (pinned UI 완성 → BE+UI 모두 full = 1.0×2 / 78%대비 약 +1%)

## 이번 iteration 선정

**Link unfurl / OpenGraph 임베드** (HIGH 갭 #3 — `.qf-embed` CSS 만 있고 BE 0)

### 현재 상태

- DS 가 이미 `.qf-embed` / `__site` / `__title` / `__desc` CSS 클래스 보유 (apps/web/public/design-system/components.css:473-480)
- BE 의 OpenGraph 메타데이터 scraper 부재
- `parseContent.tsx` 가 URL 을 `<a>` 로 렌더하지만 미리보기 카드 없음
- DS index.html 에 `qf-embed` 사용 예시 ([§ DM 섹션] 부근)

### 보안 위험

- URL fetch 시 SSRF (Server-Side Request Forgery) 위험:
  - `http://localhost/admin` → 내부 서비스 정보 노출
  - `http://169.254.169.254/...` → AWS metadata (NAS 환경엔 무관하나 일반화 필수)
  - `file:///etc/passwd` → file:// scheme 차단 필수
  - `http://10.x.x.x` 등 사설 IP 범위 차단
  - DNS rebinding 공격 → 첫 IP 검증 + 실제 fetch 시 같은 IP 강제

## 제약

- DS 4파일 수정 금지 (이미 `.qf-embed` 존재 — 추가 수정 X)
- migration: LinkPreview 캐시 테이블 1개 (reversible)
- SSRF guard 는 critical 보안 항목 — security-scanner 가 막으면 BLOCKER → fix-forward
- 외부 dep 추가는 최소 (cheerio 또는 node-html-parser 한 개)

## 측정

- 신규 endpoint: 1 (GET /links/preview?url=...)
- 신규 컬럼: LinkPreview 캐시 테이블 (url PK, ogTitle, ogDescription, ogImage, ogSiteName, fetchedAt, statusCode)
- 신규 spec: SSRF guard unit + scraper unit + preview endpoint integration (선택)
- FE 변경: parseContent 의 URL 매칭 부분이 LinkPreview 데이터를 lazy-fetch + 카드 렌더 (옵션)

## 분할 전략

규모를 고려해 **iter 2-A (BE) + iter 2-B (FE)** 로 가능한 분할. 시간 budget 따라 한 iteration 에서 모두 처리 가능하면 그렇게.
