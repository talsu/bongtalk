# Task 050 — DS Slack/Discord-level UI/UX Upgrade

## Context

사용자 피드백: UI/UX가 Slack/Discord 대비 부족, 특히 **모바일 동선**.
디자인 시스템(`apps/web/public/design-system/`)만 먼저 그 수준으로 업그레이드.
실제 서비스 반영은 후속 작업(별도 task).

벤치마크 합성: `docs/tasks/050-ds-benchmark-synthesis.md`
(10영역 × (web research → gap) 파이프라인 + opus 합성, 121 finding).

## Scope

### IN

- `tokens.css` — 신규 토큰 28종 + 토큰 값 교정 + `prefers-reduced-motion` 전역 가드
- `components.css` — 데스크톱 컴포저/자동완성/슬래시/cmd-palette/emoji-picker/오버레이군/
  메시지 액션 완성/밀도 시스템(2단계) + 기존 규칙 surgical 교정(raw 박멸·모션·위계)
- `mobile.css` — OverlappingPanels 3패널 + 전역 고정 탭바 + 탭 pill + 키보드 inset +
  unread divider/jump/swipe + 모바일 IA(서버헤더·Home타일·필터칩·You·thread inbox)
- `index.html` — 신규 컴포넌트 showcase 섹션 반영(DS self-documenting 유지)
- `icons.*` — 필요 시 신규 아이콘 보강

### OUT

- 실제 앱(`apps/web/src/**`) 반영 — 후속 task
- voice/WebRTC (direction pivot 준수)
- 새 폰트/색 브랜드 변경 (violet + night/lavender 유지, Slack aubergine/Discord blurple 복제 금지)

## Direction decisions (확정)

1. 서버 레일 hover = **형태 morph** (hover: bg-hover+squircle, selected만 accent fill)
2. 밀도 = **2단계 cozy/compact** (`[data-density]`, spacious 토큰 예약)
3. 모바일 활성 탭 = **하단 violet pill + 아이콘 scale(1.1)**
4. eyebrow = **UI 레이블 sans, 코드 컨텍스트만 mono**

## Acceptance Criteria (기계 검증)

- [ ] 신규/변경 토큰이 `tokens.css`에 존재, 모든 신규 컴포넌트가 토큰 경유
- [ ] `prefers-reduced-motion` 가드 존재 (WCAG 2.3.3)
- [ ] 신규 CSS 블록에 raw hex (`#`) 0건 (1px 하어라인 보더 제외 정책)
- [ ] 모바일 인터랙티브 히트박스 ≥ `--m-touch`(44px)
- [ ] DS 4파일 prefix 규칙 준수 (qf-_ / qf-m-_)
- [ ] `pnpm verify` green (DS는 CSS-only지만 web 빌드 영향 없음 확인)

## Non-goals

- 앱 컴포넌트 리팩터링, 픽셀 단위 visual regression 시드(후속)

## Risks

- 브랜드 희석(Slack/Discord 모방 과잉) → brand_guardrails 강제, accent=violet 고정
- index.html 대량 변경 → CSS(source of truth) 우선, showcase는 주요 컴포넌트 중심
- ⚠️ **DS↔앱 결합**: apps/web/index.html이 /design-system/_.css를 직접 link →
  토큰/기존 qf-_ 변경은 배포 시 실앱 즉시 반영. 신규 클래스는 dormant.
  ([[reference_ds_app_coupling]]) → 배포 전 visual-regression + 사용자 확인 필요.

## Results (구현 완료, 미배포)

- tokens.css: +28 토큰, --bg-input n-0→n-2, badge/scrim 대비 교정, reduced-motion 가드. 255→307행.
- components.css: surgical(server morph, channel unread+pill, msg toolbar fade, eyebrow sans,
  avatar/typing/skel 토큰화) + 신규(composer, autocomplete/slash, cmd-palette, emoji-picker,
  overlays 8종, msg-actions, density 2단계). 644→1724행.
- mobile.css: surgical(tabbar bg-app+z, tab pill, badge 의미분리, 컴포저 44px+키보드 inset,
  swipe/react 토큰화) + 신규(OverlappingPanels 3패널, unread-divider, jump-btn, IA tiles/chips/
  you/thread-inbox, emoji-drawer, screen--app). 369→1024행.
- index.html: v4 showcase 5페이지 + 사이드바 그룹. v=7 캐시버스터.
- 검증: 중괄호 균형 OK, 미정의 토큰 0, prefix 누수 0, 신규 raw hex 0, **pnpm verify green(exit 0)**.
- 리뷰: ui-designer + accessibility-auditor 통과(브랜드 가드 PASS, 4 결정 모두 구현, reduced-motion 호평).
  050 도입 대비 이슈는 fix-forward 완료, 나머지(systemic/styleguide a11y)는 [[051]] 분리.
- 시각검증: Docker Playwright 로 5페이지 렌더 캡처 → 사용자 전달.

## DoD

- [x] 신규/변경 토큰 tokens.css 존재 + 컴포넌트 토큰 경유
- [x] prefers-reduced-motion 가드(WCAG 2.3.3)
- [x] 신규 CSS 블록 raw hex 0
- [x] 모바일 히트박스 ≥ --m-touch
- [x] prefix 규칙 준수
- [x] pnpm verify green
- [ ] (보류) 배포 + 실앱 visual regression — 사용자 확인 대기
