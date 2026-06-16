# 075 · qufox → design.qufox.com CSS 직접 참조 (SSOT)

> 상태: DONE (검증 green, 배포)
> 작성: 2026-06-17 · 선행: [[074-design-system-repo-separation]]

## Context

DS가 별도 repo(qufox-design)로 성숙(v0.1, 컴포넌트 126, 브랜드 5종, 화이트라벨 G-3 완료)하고
`design.qufox.com`에 라이브 발행됨(모든 경로 200, CORS `*`, charset utf-8, `/v0.1/` 스냅샷).
사용자 요청: SSOT를 위해 qufox가 **design.qufox.com CSS를 직접 참조**(롤링 최신).

## Change

- `apps/web/index.html` · `apps/web/public/prd/index.html`: DS CSS를 로컬 `/design-system/*.css`
  에서 **`https://design.qufox.com/{tokens,components,mobile,icons[,docs]}.css` 롤링 최신**으로
  전환 + `preconnect`. (사용자 선택: 롤링 최신. 가이드는 prod에 `/v0.1/` 핀 권장이나 사용자가
  항상-동기 우선.)
- 로컬 사본 제거(SSOT): `public/design-system/{tokens,components,mobile,docs,icons}.css` +
  카탈로그 `index.html` + mockup `*.jsx` 3종. **`icons.svg`는 유지** — cross-origin SVG `<use>`가
  브라우저 차단되어 동일 출처 필수(`Icon.tsx`가 `/design-system/icons.svg` 참조).
- 폐기 e2e: `ds-mockup-parity.e2e.ts` + `visual/visual-baseline.e2e.ts`(+스냅샷 22) — 제거된 로컬
  카탈로그에 의존. DS visual QA는 이제 qufox-design repo가 보유. `real-app-baseline.e2e.ts`(실
  라우트 /login·/signup·/invite)는 유지.
- `scripts/deploy/tests/dist-css-link-smoke.sh`: 로컬 링크 가드 → **CDN 링크 + 스테일-로컬 회귀
  가드 + 도달성**으로 재목적화(029 회귀 가드 계승).

## Trade-offs (수용)

- 런타임이 design.qufox.com 가용성에 결합 — 단 동일 NAS·동일 nginx-proxy(같은 실패 도메인),
  CORS `*`. 불가 시 무스타일 폴백(JS/라우팅 정상).
- 롤링 최신 = 버전 핀 없음 → DS 변경이 즉시 prod 반영(사용자 명시 선택). 캐시 헤더는 인프라 확인 권장.
- 외부 CSS, SRI 없음 — 롤링과 본질적으로 양립 불가(해시 고정 불가), 동일 신뢰 도메인이라 수용.

## Verification

- `pnpm verify` green (19/19 task, 1884 test).
- `pnpm ds:smoke` green (web 빌드 + dist가 CDN 4개 링크 + 스테일 로컬 0 + 도달성 200).
- reviewer 적대 재독: **BLOCKER 0**. HIGH-1(폐기 스모크) + MEDIUM-1(PRD dead-link) fix-forward 완료.

## Acceptance

- [x] 라이브 앱/PRD가 design.qufox.com CSS 직접 참조
- [x] 로컬 CSS 사본 제거(icons.svg만 잔존), 폐기 e2e 정리
- [x] verify + ds:smoke green, reviewer BLOCKER 0
- [ ] prod 배포 후 `/readyz` 200 + qufox.com 이 CDN CSS 링크 확인

## Follow-ups (범위 밖)

- 실앱 visual regression 확충(롤링 최신이므로 카탈로그 대신 실앱 baseline 가치↑).
- design.qufox.com `Cache-Control` 정책 확인.
- qufox-design 컴포넌트 확장(별도 제안).
