# Task 049 — Verification & Stability Debt Cleanup · PR notes

## 요약

048 이 deferred 한 visual regression 검증 부채 3건 + UNDERSTAND 에서
발견한 CI 회귀 1건을 청산했다. 모든 baseline 은 prod(`https://qufox.com`)
기준 `--project=chromium` 으로 시드해 `-chromium-linux` 접미사로 통일.

## Baseline 시드 환경 (표준 첫 row)

| 항목        | 값                                                                      |
| ----------- | ----------------------------------------------------------------------- |
| seed source | `https://qufox.com` (prod)                                              |
| seed runner | `mcr.microsoft.com/playwright:v1.48.2-jammy` (docker, `--network host`) |
| project     | `chromium` (접미사 `-chromium-linux` 통일)                              |
| 기준 commit | main `6b40d3a` (048 머지 후)                                            |
| threshold   | `maxDiffPixelRatio` 0.02                                                |

## Chunk 별 변경

### A. Real-app visual baseline (구조적 fix)

- 신규 `apps/web/e2e/visual/real-app-baseline.e2e.ts` — 익명 real app
  route 픽셀 baseline: `/login` (LoginPage), `/signup` (SignupPage),
  `/invite/__nonexistent__` (InviteAcceptPage invalid).
- 045/046 의 19 baseline 이 전부 DS mockup(`/design-system/index.html`)
  만 캡처해 실제 AppLayout/ErrorBoundary 트리를 검증한 적 없던 구조적
  공백을 메움 (047 iter7 회귀가 안 잡힌 근본 원인). 048 chunk B 의
  numeric height assertion 을 픽셀로 보완.
- baseline 3개: `real-{login,signup,invite-invalid}-chromium-linux.png`.
- 인증 필요 surface → `TODO(task-049-follow-auth-baseline)` 분리.

### B. mobile-046 broken baseline 8개 정정

- 근본 원인 (prod 진단으로 확정): 8 surface 의 `.phone` 프레임은
  `data-page="mobile"` 가 아니라 `app-workspace`/`app-channel-settings`/
  `app-modals`/`app-threads`/`app-dms` **각 페이지**에 분산. `#mobile`
  활성화 시 나머지 페이지는 `display:none` → global `.nth()` 가 가리킨
  요소가 0×0 → "element is not visible" 104회 retry 후 timeout.
- 정정: 각 surface 를 자기 DS 페이지로 navigate 후 `section[data-page=
"X"].active .qf-m-screen` within-page nth 로 캡처 (358×718 정상 렌더).
- baseline 8개: `mobile-046-{discover,workspace-create,channel-composer,
members,pinned-panel,thread,dm-list,dm-thread}-chromium-linux.png`.
- DS 4파일 unchanged — test-side only.

### B'. mobile-overview flake 정정 (신규 발견)

- 045 `mobile-overview` 는 mobile 페이지를 `fullPage` 캡처했는데 page
  scrollHeight 가 **5204↔5222px (18px) 진동** → toHaveScreenshot 이
  안정 dimension 을 못 얻어 "Timeout 5000ms exceeded" 로 상시 fail
  (threshold 무관).
- 정정: mobile 페이지의 4 device frame (`.qf-m-screen`, 각 304×608 고정
  box) 을 element screenshot 으로 분리. 구 단일 fullPage baseline 폐기,
  `mobile-overview-{dm,general,activity,voice}-chromium-linux.png` 4개로
  대체. 결정성 2회 연속 확인.

### C. VRS 호출을 mechanical contract step 으로 승격

- 049 AC 에 "visual-regression-scanner 호출 ≥ 1회" 명시.
- **이 task 에서 실제로 visual-regression-scanner subagent 1회 spawn**
  (048 audit 의 "Agent tool 미노출" 이 현 세션에서 해소됨을 실증).
  - transcript: 50,176 tokens / 39 tool uses / ~117s
  - verdict: 전 항목 PASS, "GREEN for merge" (DS 4파일 MD5 unchanged 확인 포함)
- `docs/audits/visual-regression-agent-audit.md` Deferred → task-049
  resolution 갱신.

### D. CI visual e2e project 스코핑 (latent 회귀 수정)

- 048 chunk D 가 baseURL 분기용 4 project 를 추가했는데 `e2e.yml` /
  `run-e2e.sh` 가 project filter 없이 `playwright test` 를 돌려 모든
  테스트 4× 실행 → visual snapshot 이 `-chromium-linux` 한 벌뿐이라
  3/4 project fail (prod 실측: `desktop · shell` 1 passed / 3 failed).
- `.github/workflows/e2e.yml`, `scripts/run-e2e.sh` → `--project=chromium`
  단일 스코핑. CI baseURL 은 localhost(테스트 스택)이고 4 project 가
  동일 baseURL 이라 functional 커버리지 손실 0 (redundant 제거).
- `playwright.config.ts` 에 정책 주석.

## 검증

| 항목                                           | 결과                           |
| ---------------------------------------------- | ------------------------------ |
| `pnpm verify`                                  | green (19/19, 0 errors)        |
| prod 전체 visual+layout (`--project=chromium`) | 26 passed / 3 flaky / 0 failed |
| mobile-046 8 + mobile-overview 4 결정성        | 2회 연속 green                 |
| DS 4파일                                       | unchanged (`git diff` 0)       |
| VRS subagent spawn                             | 1회 (verdict GREEN)            |

**3 flaky (real-invite-invalid, desktop-shell, desktop-channel-empty)**:
스크린샷 불일치 아님 — prod 네트워크 지연 + 4-worker trace 아티팩트
경합(ENOENT/30s timeout) 으로 1차 실패 후 retry 통과. desktop-shell/
channel-empty 는 기존 045 fullPage baseline. CI 는 localhost(빠름) 라
경합 영향 작음. fullPage 의 prod-network flake 저감은
`TODO(task-049-follow-fullpage-flake)`.

## Deferred TODO

- `TODO(task-049-follow-auth-baseline)`: 인증 필요 real-app surface
  (authenticated shell/channel/dm) — fixture workspace 시드 후 baseline.
- `TODO(task-049-follow-fullpage-flake)`: desktop fullPage baseline 의
  prod-network/concurrency flake 저감 (workers 조정 또는 element 분리).
- `TODO(task-048-follow-vrs-baseline-policy)`: (carry) baseline 시드 env
  를 PR template 표준 row 로.

### D'. un-baselined screenshot specs (reviewer #1, fix-forward)

- `ds-mockup-parity.e2e.ts` (mockup-dark/light), `vr-parity.e2e.ts`
  (mobile-shell-iphone-se/14) 도 baseline 미보유 → chromium CI 상시 fail
  (선행 부채). chunk D 의 "CI green" 을 완성하려면 처리 필요.
  - `mockup-{dark,light}`: 정적 DS → prod 시드 (결정성 2회 확인).
  - `vr-parity`: 인증 live shell + 테스트 스택 필요. prod NAS 가 host
    5432/6379 를 prod 가 점유 중이라 안전 기동 불가 → `test.fixme` +
    `TODO(task-049-follow-vr-parity-baseline)`.

## Reviewer

- **reviewer subagent**: APPROVE-with-nits (BLOCKER 0 / HIGH 0),
  51,116 tokens / 32 tool uses / ~203s.
- finding 1(MED)/2/3/4(LOW)/5(NIT) 전부 fix-forward (상세
  `049-*.review.md`).
- **visual-regression-scanner subagent** (chunk C): GREEN for merge,
  50,176 tokens / 39 tool uses / ~117s.
