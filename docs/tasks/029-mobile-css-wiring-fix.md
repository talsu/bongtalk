# Task 029 — Mobile CSS Wiring Fix + VR Baseline Reseed (urgent hotfix) → main deploy

## Context

Live prod 환경에서 모바일 viewport로 qufox.com 접속 시 DS
mockup의 모바일 스타일이 전혀 입혀지지 않는다는 사용자 보고.

**Root cause (pane 1 진단):** `apps/web/index.html`이 DS
CSS 네 개 중 세 개만 link하고 `mobile.css`를 **누락**:

```html
<link rel="stylesheet" href="/design-system/tokens.css" />
<link rel="stylesheet" href="/design-system/components.css" />
<!-- ← 여기 mobile.css link 빠짐 -->
<link rel="stylesheet" href="/design-system/icons.css" />
```

결과:

- `apps/web/src/`에 `qf-m-*` 클래스가 182건 사용되지만 CSS
  규칙은 문서에 로드되지 않아 매칭 0건
- `/design-system/mobile.css`에 정의된 `qf-m-screen` /
  `qf-m-topbar` / `qf-m-tabbar` / `qf-m-row` 등 전부 무력화
- DS 라이브 문서 (`/design-system/index.html`)는 `<link
href="mobile.css?v=6">` 포함이라 거기서는 정상 렌더 — 사용자
  관찰과 정확히 일치
- `mobile-kb-dodge.css` / `mobile-touch-target.css` 두 개만
  `MobileShell.tsx`에서 import되어 번들되지만 본진 스타일은
  아님

**왜 VR test가 못 잡았나:** Playwright screenshot 역시 스타일
없는 상태로 찍혔고, 그 baseline이 024부터 commit되어 매번
"parity pass"로 통과. 즉 **baseline 자체가 처음부터 오염된 상태**.

029는 한 줄 fix + 시각 재검증 + 미래 회귀 방지 guard를 묶은
긴급 hotfix.

## Scope (IN) — 7 chunks

### A. `apps/web/index.html`에 mobile.css link 추가

```html
<link rel="stylesheet" href="/design-system/tokens.css" />
<link rel="stylesheet" href="/design-system/components.css" />
<link rel="stylesheet" href="/design-system/mobile.css" />
<link rel="stylesheet" href="/design-system/icons.css" />
```

순서: tokens → components → mobile → icons (tokens + components
의 변수 먼저 로드되어야 mobile이 참조 가능).

DS `mobile.css`는 건드리지 않음 (memory source-of-truth 준수).

### B. VR baseline 전면 재시딩

- `apps/web/e2e/mobile/mobile-vr-parity.mobile.e2e.ts`의
  `-snapshots/` 디렉토리 현존 PNG 전부 삭제:
  - 375×667 light / dark
  - 390×844 light / dark
- `--update-snapshots` 옵션으로 Playwright 1회 실행 → 새
  baseline 자동 생성 (이번엔 mobile.css가 로드된 상태에서 찍힘)
- 새 PNG git commit
- 024부터 commit됐던 잘못된 baseline은 전부 교체

### C. 시각 검증 (PR.md 증거)

- `/design-system/index.html#mobile`의 `ScreenDMs` /
  `ScreenChannel` / `ScreenActivity` / `ScreenVoice` 목업과
  live app 같은 viewport (375×667) screenshot을 **나란히**
  비교
- 각 screen의 live 화면과 mockup screen을 PR.md에 inline
  image 또는 attached link로 첨부 (4쌍)
- 주요 요소 체크: topbar 높이 52px, tabbar 높이 56px + safe-area,
  `qf-m-row` 64px, `qf-m-fab` 그림자, `qf-m-segment` radii 등

### D. Regression guard: dist CSS link smoke

- 신규 `scripts/deploy/tests/dist-css-link-smoke.sh`:
  ```bash
  set -euo pipefail
  cd /volume2/dockers/qufox
  pnpm --filter @qufox/web build
  DIST_HTML="apps/web/dist/index.html"
  for css in tokens.css components.css mobile.css icons.css; do
    grep -q "/design-system/$css" "$DIST_HTML" || {
      echo "MISSING link: $css in $DIST_HTML" >&2; exit 1;
    }
  done
  echo "ok: 4 DS css links present in dist/index.html"
  ```
- `.github/workflows/integration.yml`에 step 추가 (또는 별도
  workflow file `design-system-smoke.yml`)
- 신규 `dist-css-link-smoke` GHA job — PR 시 실행
- Local: `pnpm ds:smoke` root script 등록

### E. Sanity audit — 다른 DS 자산 link 누락 여부

- `apps/web/index.html` vs DS 디렉토리 실제 CSS 파일 diff:
  - `tokens.css` ✓
  - `components.css` ✓
  - `mobile.css` ✓ (A에서 추가)
  - `icons.css` ✓
  - 그 외 `.css` 파일 없음 (mobile-mockups.jsx / ios-frame.jsx는
    DS 라이브 문서 전용)
- `/design-system/icons.svg`는 `Icon` primitive가 fetch하므로
  HTML link 필요 없음 — 확인만
- `brand-assets/*` 링크 점검 (site.webmanifest, favicon 등은
  이미 정상)
- audit 결과 PR.md에 기록

### F. develop → main auto-promote + deploy 검증

표준 flow per `feedback_auto_promote_to_main.md`:

1. `git checkout develop && git pull --ff-only && git merge --no-ff feat/task-029-mobile-css-wiring-fix -m "Merge task-029: mobile.css HTML link fix + VR baseline reseed" && git push origin develop`
2. `git checkout main && git pull --ff-only && git merge --no-ff develop -m "Deploy task-029 to prod: mobile CSS wiring fix" && git push origin main`
3. Wait 1–3 min
4. `tail -1 /volume2/dockers/qufox-deploy/.deploy/audit.jsonl`
   — `exitCode=0` + sha matches main tip
5. `curl -sk https://qufox.com/api/readyz` → 200
6. idle-window 30s 6 probes 모두 200
7. **live 모바일 검증** — 사용자가 실 기기 혹은 브라우저
   모바일 에뮬레이션으로 qufox.com 접속 → DS mockup과 비교
   (FINAL REPORT에 scheduling)

### G. Pane 1 auto-forward (7th application)

Per memory. 표준 format.

## Scope (OUT)

- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  수정 (source of truth)
- 새 기능 (Loki, PITR, Voice, Custom emoji — Task 030 이후)
- VR test의 threshold 변경
- `index.css` 안에서 `@import`로 mobile.css 끌어오는 대안 (HTML
  link가 DS-외부에서 가장 clean)
- `mobile-kb-dodge.css` / `mobile-touch-target.css` 이동 (이들은
  app-specific 보완 규칙이라 apps/web/src 유지)

## Acceptance Criteria (mechanical)

- `apps/web/index.html` 에 `mobile.css` link **존재**.
- `apps/web/dist/index.html` (build 산출물)에도 동일 link
  포함 (Vite가 public/ 에서 자동 복사).
- `bash scripts/deploy/tests/dist-css-link-smoke.sh` green
  locally + GHA.
- VR baseline PNG (`apps/web/e2e/mobile/mobile-vr-parity.mobile.e2e.ts-snapshots/`)
  4개 교체 + git commit.
- 교체된 baseline의 렌더가 이전과 확연히 다름 (git diff로 시각
  변화 확인 가능) — 이전은 스타일 없는 모습, 이후는 mockup과
  유사.
- `pnpm --filter @qufox/web test:e2e` green on GHA including the
  reseeded VR baselines.
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  git diff 0 (untouched).
- 3 artefacts: `029-*.md`, `029-*.PR.md`, `029-*.review.md`.
  - PR.md 는 **live app 4 screen vs mockup 4 screen 시각 비교**
    포함.
- 1 eval 신규: `evals/tasks/040-mobile-css-wiring.yaml`.
- Reviewer subagent 실제 스폰 + token count 기록.
- 직접 develop merge.
- develop → main auto-promoted via webhook.
- `.deploy/audit.jsonl` last entry `exitCode=0` + sha matches
  main tip.
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s.
- **Pane 1 auto-forwarded** FINAL summary (7th application).
- Feature branch retained.
- FINAL REPORT 포함:
  - mobile.css link fix 커밋 SHA
  - VR baseline 교체 개수 (4개 기대)
  - dist smoke 실행 결과
  - live prod 검증 방법 안내 (사용자가 qufox.com을 모바일로
    열었을 때 확인할 포인트)
  - 남은 design follow-up (mockup 대비 여전히 차이가 있다면
    task-029-follow-\* 로 기록)

## Prerequisite outcomes

- 028 merged + deployed (`2574bde` main)
- `mobile.css` 파일 `/volume2/dockers/qufox/apps/web/public/design-system/mobile.css`
  에 존재 (확인됨, 361줄)
- Vite public 디렉토리 복사 규약 (`publicDir` 기본값 = `public`)
  live
- Playwright `--update-snapshots` 실행 가능한 GHA 또는 local
  환경

## Design Decisions

### HTML `<link>` 유지, `index.css`에서 `@import` 안 함

옵션 A (`<link>`): 이미 tokens/components/icons가 같은 방식.
일관성 + cache 세분화 + HTML 파싱 중 preload 가능.
옵션 B (`@import`): Vite가 bundle로 묶음 → 하나의 파일로 합쳐
져 초기 네트워크 요청 줄지만 DS와 앱 코드가 섞여 cache 분리
이득 상실.
→ **A 채택**. DS CSS와 앱 CSS를 분리 유지.

### VR baseline 전면 재시딩

이전 baseline은 스타일 없는 상태에서 찍혔으므로 현재와 비교하면
diff가 100%에 가까울 것. threshold 내 조정이 아니라 새 기준선
을 수용하는 것이 정답.

### Smoke test는 build 산출물 기준

src index.html 검증은 dev에서 OK. prod 배포 후 문제가 재발하지
않으려면 `dist/index.html` (vite build 결과)가 DS link 전부
포함해야 함. script가 build → dist inspect 패턴.

### Live prod 검증은 사용자에게 위임

Playwright VR은 CI 환경에서의 브라우저 렌더. 실 기기 (iOS
Safari / Android Chrome)의 렌더가 완전 동등하지 않을 수 있음.
FINAL REPORT에 "qufox.com을 모바일로 열어 4개 screen과 DS
mockup 나란히 확인" 절차 기록.

## Non-goals

- 성능 최적화 (CSS link 4개 → 1 번들로 합치기 등)
- 새 qf-m-\* 클래스 추가
- Mobile feature 추가
- 028 이후 남아있는 polish follow 정리 (다음 task)

## Risks

- **mobile.css의 CSS 규칙이 components.css 규칙과 의도치 않게
  겹쳐 선언 순서 변경으로 시각 차이 발생** — DS source of truth
  가정 하에선 DS가 자체 일관성 보장했을 테지만, `qf-m-row` +
  `qf-row` 같은 유사 클래스 충돌 가능성 확인. UNDERSTAND에서
  grep audit.
- **VR baseline 재시딩 후 GHA 실패** — 시딩이 local에서 됐지만
  GHA Playwright 환경의 렌더 차이로 fail 가능. threshold 2% 내
  조정 필요. 최악의 경우 GHA 전용 baseline 분기.
- **`dist/` 빌드 시간** — 027에서 1분 이내 확인됨. 이 task에
  CSS link 추가 외 실질 번들 변경 없어 더 빠를 것.
- **Prod 배포 후 사용자 검증이 환경에 따라 달라질 수 있음** —
  iOS Safari 14+ / Android Chrome 100+ 가정. 구 브라우저 예외는
  scope out.
- **mobile.css 로드 후 기존 데스크톱 레이아웃이 바뀌는 side
  effect** — mobile.css가 데스크톱 `<768px`에만 적용되는 규칙만
  있는지 (media query 기반이 아닐 수도), 또는 모든 viewport
  에 무차별 적용되는지 확인. UNDERSTAND에서 mobile.css 의 상위
  20줄 훑어서 `@media` 사용 여부 확인.

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (mobile.css가 `@media` 기반인지, components.css
      와 충돌 가능성, VR baseline 위치 확인, Vite publicDir
      복사 확인)
- [ ] PLAN approved
- [ ] SCAFFOLD (A patch 준비, D smoke script 작성 red, VR
      baseline 삭제 준비)
- [ ] IMPLEMENT (A → D → B → C → E)
- [ ] VERIFY (`pnpm verify` + GHA e2e green + dist smoke green + live prod 수동 확인)
- [ ] OBSERVE (live prod 모바일 screenshot 4개와 mockup 4개
      비교 captions 기록)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT printed + **pane 1 auto-forwarded**)
