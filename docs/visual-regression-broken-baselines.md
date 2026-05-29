# Visual regression baseline — broken/insufficient surface audit

**Task**: 048 chunk A
**Reseed source**: `https://qufox.com` (prod) at main `23492be`
**Reseed runner**: Playwright `mcr.microsoft.com/playwright:v1.48.2-jammy`
via `docker run … --network host` (NAS chromium-1140 부재 libatk
workaround, 메모리 `feedback_docker_isolated_playwright`)
**기존 baseline 시드**: 045 iter 0 (desktop 7 + mobile-overview 1) +
046 iter 2 (mobile-046 8 — 시드 실패)
**기준 commit**: `23492be` (047 hot-fix 직후, ErrorBoundary `<div>`→`Fragment`)

## TL;DR

기존 19 baseline 중 **8개만 실재** (desktop 7 + mobile-overview 1).
prod 재시드 결과 8개 모두 byte-identical (md5 동일) — DS source-of-truth
(`/design-system/index.html`) 가 040 부터 untouched 라 dev↔prod drift
없음. 그러나 **진짜 결함**은 두 가지:

1. **mobile-046 8 surface 의 baseline 이 디스크에 존재하지 않음** —
   046 iter 2 가 baseline 시드를 commit 하지 않은 채 task 종료. 048
   reseed 시도에서도 `.qf-m-screen.nth(N)` element-not-visible 로 시드
   실패. 즉 046 의 visual coverage 매트릭스 자체가 **broken**.
2. **Real app routes 가 baseline 에 한 번도 안 들어감** — 19 surface
   전부 `/design-system/index.html#<page>` (DS mockup) 만 캡처.
   `apps/web/src/App.tsx` 의 AppLayout / Routes / ErrorBoundary 트리는
   baseline 의 검증 대상이 **아님**. 이것이 047 iter 7 의 ErrorBoundary
   회귀 (정상 path `<div>` wrap → AppLayout flex 흐름 끊김 → 화면 전체
   collapse) 가 visual snapshot 으로 잡히지 않은 **구조적 원인**.

## A. Reseed 결과 (8 surface — byte-identical)

| surface                  | 기존 md5                           | 재시드 md5                         | drift |
| ------------------------ | ---------------------------------- | ---------------------------------- | ----- |
| desktop-shell            | `84d7e148630ef7208dbc1e9779a37b5d` | `84d7e148630ef7208dbc1e9779a37b5d` | 0%    |
| desktop-channel-empty    | `eab5b3a34a033cf33b228d43d8c5d21f` | `eab5b3a34a033cf33b228d43d8c5d21f` | 0%    |
| desktop-dm-list          | `2028e760bbfca214fa364f2c6ce8a1c9` | `2028e760bbfca214fa364f2c6ce8a1c9` | 0%    |
| desktop-dm-thread        | `73df1b3892b26ed46f6b00246ff1e8f6` | `73df1b3892b26ed46f6b00246ff1e8f6` | 0%    |
| desktop-settings         | `ebbdb791e4a5d569248ced5c96731915` | `ebbdb791e4a5d569248ced5c96731915` | 0%    |
| desktop-discover         | `03d6bcfbcc448e7671bab1021236aa9a` | `03d6bcfbcc448e7671bab1021236aa9a` | 0%    |
| desktop-channel-settings | `d2b76777d62e28278db5b65fd03f3af7` | `d2b76777d62e28278db5b65fd03f3af7` | 0%    |
| mobile-mobile-overview   | `aaae49cdd35cb7fc24145acfa73f78bd` | `aaae49cdd35cb7fc24145acfa73f78bd` | 0%    |

해석: 기존 baseline 은 prod 와 일치 → broken 아님. 단 DS mockup 한정의
지엽적 검증이라 본질적 한계 (B 항).

## B. 시드 실패 8 surface (broken — task-046 carry-over)

`task-046 mobile surface baseline (8 추가)` describe 의 8 케이스 모두
`page.locator('.qf-m-screen').nth(N).scrollIntoViewIfNeeded()` 가
`element is not visible` 100+ retry 후 timeout.

| surface                     | nth | 원인 추정                                                                                               | 상태       |
| --------------------------- | --- | ------------------------------------------------------------------------------------------------------- | ---------- |
| mobile-046-discover         | 0   | DS mobile 페이지의 `.qf-m-screen` 첫 번째가 viewport visible 조건 미충족 (전체 페이지가 13 frame stack) | **broken** |
| mobile-046-workspace-create | 1   | 동일                                                                                                    | **broken** |
| mobile-046-channel-composer | 2   | 동일                                                                                                    | **broken** |
| mobile-046-members          | 3   | 동일                                                                                                    | **broken** |
| mobile-046-thread           | 6   | 동일                                                                                                    | **broken** |
| mobile-046-dm-list          | 7   | 동일                                                                                                    | **broken** |
| mobile-046-dm-thread        | 8   | 동일                                                                                                    | **broken** |
| mobile-046-pinned-panel     | 4   | 동일                                                                                                    | **broken** |

**원인**: `qf-m-screen` 은 mobile DS 페이지에서 `display:flex` column 의
세로 정렬 13 frame. viewport `375×700` 에 첫 frame 만 visible,
나머지는 fold 아래. `scrollIntoViewIfNeeded()` 는 visibility 가 0 이
아닌 viewport 진입을 의미하므로 frame 자체가 viewport 안에 들어와도
`.qf-m-screen` 의 css `min-height` / `position` 에 따라 visibility
판정 실패 가능. 046 iter 2 가 baseline 시드 시점에 이걸 잡았다면 commit
했을 텐데 — 046 PR.md 가 시드 단계 검증 누락 (visual-regression-scanner
agent 도 호출 안 됨, audit C 참조).

**조치**: 048 에서는 식별만. 정정은 **TODO(task-048-follow-mobile-046-broken)** —
mobile DS 의 frame 별 element handle 시드 전략 재설계 (예:
`page.evaluate(() => document.querySelectorAll('.qf-m-screen')[N])` 직접
position 조작) 또는 DS 측 anchor id 추가.

## C. 진짜 coverage gap — real app routes 무시드

기존 baseline 0개 / 회귀 발생 surface 1개 (`/`, `/w/:slug/*` 의 AppLayout).

| 회귀 종류                            | DS mockup baseline                     | real app baseline | 검출 가능 여부 |
| ------------------------------------ | -------------------------------------- | ----------------- | -------------- |
| 047 iter7 ErrorBoundary `<div>` wrap | 영향 없음 (DS 는 ErrorBoundary 미렌더) | **없음**          | **불가능**     |
| AppLayout flex 흐름 차단             | 영향 없음                              | **없음**          | **불가능**     |
| Lazy import 실패                     | 영향 없음                              | **없음**          | **불가능**     |
| ConnectionBanner 깨짐                | 영향 없음                              | **없음**          | **불가능**     |

**대응**: chunk B 의 `apps/web/e2e/layout/app-layout-height.e2e.ts` 가
real app route 7개에서 root container height 가 viewport 의 95% 이상
임을 검증 → ErrorBoundary 같은 wrapper `<div>` 추가 시 즉시 fail.
visual snapshot 의 픽셀 diff 와 달리 numeric layout assertion 이라
threshold 무관하게 강함.

## D. 권고 (048 종결 후 deferred)

- `TODO(task-048-follow-mobile-046-broken)`: mobile-046 8 surface 의
  baseline 시드 전략 재설계 + DS 페이지 anchor 보강
- `TODO(task-048-follow-real-app-baseline)`: 19 → 26+ 으로 확장. real
  app `/login`, `/signup`, `/invite/<code>`, `/design-system/`,
  `/me/profile` (anonymous), `/dm` (anonymous), `/discover` (anonymous)
  baseline 추가. 인증 필요 surface 는 fixture workspace 시드 후 별도
- `TODO(task-048-follow-vrs-call-rule)`: visual-regression-scanner
  agent 호출 의무를 task contract 의 **명시 step 으로 강제** (메모리에
  명시 step 으로 박힘 — agent description 만으로는 약함)

## E. task-049 resolution (부채 청산)

task-049 (Verification & Stability Debt Cleanup) 에서 B / C 항 + D 권고의
real-app baseline 을 청산:

- **B 항 (mobile-046 8 surface) — RESOLVED**: 근본 원인은 DS visibility
  한계가 아니라 **global `.nth()` 인덱싱이 비활성(`display:none`) 페이지의
  `.phone` 요소를 가리킨 것**. prod 진단으로, 8 surface 의 `.phone`
  프레임은 `data-page="mobile"` 가 아니라 `app-workspace` /
  `app-channel-settings` / `app-modals` / `app-threads` / `app-dms` 각
  페이지에 흩어져 있고 (`#mobile` 페이지엔 4 frame 만 존재), `#mobile`
  활성화 시 나머지는 0×0 → not visible. 정정: 각 surface 를 자기 DS
  페이지로 navigate 후 활성 섹션 내부 within-page nth 로 캡처 →
  358×718 정상 렌더. `mobile-046-*.png` × 8 디스크 commit 완료.
  DS 4파일 unchanged (test-side only).
- **D `TODO(task-048-follow-real-app-baseline)` — PARTIAL (익명 표면) →
  RESOLVED-anon**: `apps/web/e2e/visual/real-app-baseline.e2e.ts` 가 실제
  렌더된 앱 route (`/login`, `/signup`, `/invite/__nonexistent__`) 의
  픽셀 baseline 을 잡는다. AppLayout / ErrorBoundary 트리가 visual
  baseline 의 검증 대상이 됨 → 047 iter 7 류 회귀의 픽셀 검출 가능.
  인증 필요 surface (authenticated shell / channel / dm) 는 fixture
  workspace 시드 필요 → `TODO(task-049-follow-auth-baseline)` 로 분리.
- **D `TODO(task-048-follow-vrs-call-rule)` — RESOLVED**:
  `docs/audits/visual-regression-agent-audit.md` 의 task-049 갱신 참조.
- **신규 발견 (CI 회귀) — RESOLVED**: 048 chunk D 가 baseURL 분기용
  local-dev / local-dist / prod 3 project 를 추가했는데 `e2e.yml` /
  `run-e2e.sh` 가 project filter 없이 `playwright test` 를 돌려 **모든
  테스트가 4× 실행**, visual snapshot 은 `-chromium-linux` 한 벌만
  존재하므로 나머지 3 project 에서 전부 fail (prod 실측: `desktop · shell`
  1 passed / 3 failed). → CI / run-e2e 를 `--project=chromium` 단일
  스코핑, reseed 도 `--project=chromium` + prod baseURL 로 접미사 통일
  (task-049 chunk D).
- **신규 발견 (un-baselined screenshot specs, reviewer #1) — PARTIAL**:
  `ds-mockup-parity.e2e.ts` (mockup-dark/light) 와 `vr-parity.e2e.ts`
  (mobile-shell-iphone-se/14) 도 baseline 이 한 번도 commit 된 적 없어
  `--project=chromium` CI 에서 상시 fail (049 와 무관한 선행 부채).
  - `mockup-dark/light`: 정적 DS 페이지 → prod 시드 완료 (결정성 2회 확인).
  - `vr-parity`: 인증된 live mobile shell 캡처라 fixture signup +
    테스트 스택 필요. live prod NAS 는 host port 5432/6379 를 prod
    postgres/redis 가 점유 중이라 테스트 스택을 안전 기동 불가 →
    `test.fixme` 로 명시 skip + `TODO(task-049-follow-vr-parity-baseline)`
    (CI/테스트 스택 환경에서 시드).
- **신규 발견 (mobile-overview flake) — RESOLVED**: 045 의
  `mobile-overview` 는 `data-page="mobile"` 페이지를 `fullPage` 캡처했는데
  prod 진단 결과 **page scrollHeight 가 5204↔5222px (18px) 진동** →
  toHaveScreenshot 이 안정 dimension 을 못 얻어 "Timeout 5000ms exceeded"
  로 항상 fail (threshold 무관). → 4 device frame 을 element screenshot
  (각 304×608 고정 box) 으로 분리 캡처 (`mobile-overview-{dm,general,
activity,voice}.png`), 단일 fullPage baseline 폐기. 결정성 2회 연속
  확인.
