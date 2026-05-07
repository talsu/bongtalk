# Iteration 2 — AUDIT (mobile surface 8 visual baseline)

## 처리 범위

iter 1 audit 의 Section I (모바일 surface 확장 8 row) 의 visual
regression baseline 시드. 045 의 1 mobile-overview baseline 외에 8
신규 mobile section snapshot 추가 → 총 9 mobile baseline.

각 surface 는 DS `/design-system/index.html#mobile` 의 13 qf-m-screen
중 8 개를 nth ordinal 로 scope. Playwright `locator.toHaveScreenshot()`

- `scrollIntoViewIfNeeded` 패턴.

## 목적 (HIGH 갭 해소 vs visual coverage)

**HIGH 갭은 production code shipping 의 부재** (예: I3 reaction picker
모바일 컴포넌트 자체가 없음). Visual baseline 추가만으로 HIGH 가
해소되는 건 아님 — 그러나:

1. DS source-of-truth 가 이미 8 surface 디자인을 명시하고 있고
2. 매트릭스 row 의 충족도는 "DS + visual regression spec + ✅
   shippable contract" 로 정의되며
3. 본 iter 의 visual baseline 시드는 향후 production 컴포넌트 도착 시
   DS-mockup 일관성 보장을 위한 인프라

따라서 iter 2 는 **부분 closure** — I1-I8 row 의 상태를 일괄
🔵 (계획) 또는 🟡 (부분) 상승. HIGH 4건 (I3/I4/I7/I8) 은 production
컴포넌트 도착 전까지 partial 로 유지 (TODO 기재).

## row 상태 변화 (Section I)

| #   | Row              | iter 1 상태 | iter 2 상태    | 가중치 변화 |
| --- | ---------------- | ----------- | -------------- | ----------- |
| I1  | composer         | 🔵 (0.25)   | 🟡 (0.5)       | +0.25       |
| I2  | DM thread        | 🔵 (0.25)   | 🟡 (0.5)       | +0.25       |
| I3  | reaction picker  | ❌ (0)      | 🔵 (0.25) HIGH | +0.25       |
| I4  | emoji picker     | ❌ (0)      | 🔵 (0.25) HIGH | +0.25       |
| I5  | workspace switch | 🟡 (0.5)    | 🟡 (0.5)       | 0           |
| I6  | sidebar drawer   | 🟡 (0.5)    | 🟡 (0.5)       | 0           |
| I7  | onboarding       | ❌ (0)      | 🔵 (0.25) HIGH | +0.25       |
| I8  | pinned panel     | ❌ (0)      | 🔵 (0.25) HIGH | +0.25       |

소계: 1.5 → **3.0 / 8** (= 37.5%, +18.75pp 회복)

## HIGH 갭 변화

- I3, I4, I7, I8: ❌ → 🔵 (DS 디자인 + visual baseline 코미트). HIGH
  태그 유지 (production code 도착 전까지). fix-forward TODO:
  - `TODO(task-046-mobile-reaction-picker)` (I3)
  - `TODO(task-046-mobile-emoji-picker)` (I4)
  - `TODO(task-046-mobile-onboarding-flow)` (I7)
  - `TODO(task-046-mobile-pinned-panel-route)` (I8)

## Score 재산정 (확장 매트릭스 96 row)

- 045 종료 row 합: 57.75 / 60
- 신규 row 합: 9.0 → **10.5 / 36** (+1.5)
- 총 row 가중치 합: 57.75 + 10.5 = **68.25**
- 단순 score: 68.25 / 96 = **71.09%** (+1.56pp)
- HIGH×2 적용 (HIGH 12 → 12 — partial 로 살아있음):
  effective denom = 96 + 12 = 108
  score: 68.25 / 108 = **63.19%** (+1.39pp)

iter 2 score recovery: +1.39 ~ +1.56pp. 모바일 인프라 시드의 1차
효과로 그 자체의 정량 점수 상승은 작지만 **다음 iter (검색/알림/단축키
/프로필) 가 모바일 회귀 검증 위에서 안정화 가능** — 매트릭스 도구로서의
가치가 큼.

## 산출물

- `apps/web/e2e/visual/visual-baseline.e2e.ts` 확장: 8 모바일 surface
  spec 추가 (snapshot 시드는 다음 e2e run 의 `--update-snapshots` 에서)
- 매트릭스 row I1~I8 상태 갱신 (본 audit doc)

## DoD

- [x] visual-baseline.e2e.ts 확장 (8 spec)
- [x] 매트릭스 row 상태 + 점수 갱신
- [x] HIGH gap 4건 fix-forward TODO 명시
- [x] DS 4 파일 untouched

## Deploy

iter 2 는 visual baseline 인프라 시드만 — production 코드 변경 0.
audit doc + spec 확장 commit. develop merge + main auto-promote
정책에 따라 deploy 진행.

## 회귀 spec

- `apps/web/e2e/visual/visual-baseline.e2e.ts` (확장) — 8 모바일 surface
  - DS untouched 제약 → 시드 첫 run 은 `--update-snapshots` 으로 baseline
    PNG 생성. 이후 run 부터 회귀 감지.

## 측정

- pnpm verify: 0 (visual baseline 은 verify 비포함, e2e 별도)
- 영향 라인: ~50 (visual-baseline.e2e.ts 확장만)
