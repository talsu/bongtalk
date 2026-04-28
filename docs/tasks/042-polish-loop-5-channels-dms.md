# Task 042 — Production Polish Loop 5 (PL5) · Channels + DMs

## Context

040 (PL4, main=`037c71d`) + 041 (sweep, main=`17c8ab4`) 직후의 두 번째
polish iteration. 사용자가 명시한 "여러번 반복" 의 두 번째 사이클.

040 의 fix 가 prod 에서 실 운영된 후 새 issue 가 발견될 수 있고,
041 자체에서 추가 발생한 7건의 follow 도 흡수해야 한다. 040 와 동일한
8 dimension × ≤3 round 자율 반복 패턴을 그대로 적용한다.

이전 iteration 잔여:

- **041 follow 7건** (Round 0 에서 일괄 흡수):
  - jsdom-testing-env (review H3 잔여 — `<Input>` 캐피털 컴포넌트 정적 미감지)
  - presence-memo (review M1)
  - composer-race-fix (review M2 — 함수형 업데이터 reconcile)
  - mutation-unmount-cleanup (review M3)
  - delete-success-toast (review M4)
  - banner-multi-shell-e2e (review M5)
  - ios-banner-screenshot (review M6)
- **분리 OUT** (이번에도 별도 task 유지):
  - lighthouse-ci → 미래 별도 task
  - virtualization → 미래 별도 task

## Scope (IN) — 자율 반복

### Round 0 — 041 follow 흡수 (선행 chunk)

dimension audit 시작 전 7건을 fix-forward 로 정리:

1. **jsdom-testing-env** — input-label-guard 가 capital-component (예:
   `<Input />`, `<Textarea />`) 까지 정적 감지하도록 audit harness
   확장 또는 jsdom-render 기반 보완
2. **presence-memo** — `useDmPresence` selector 결과 memo 화 → DM list
   re-render 폭증 방지
3. **composer-race-fix** — `useSendMessage` 의 onMutate / onError 가
   stale closure 잡지 않도록 함수형 setState 사용
4. **mutation-unmount-cleanup** — 컴포넌트 unmount 후 mutation 응답
   처리 시 setState 호출 방어 (signal abort 또는 mount ref)
5. **delete-success-toast** — 메시지 delete 성공 시 silent → 살짝 늦은
   확인 toast (실패 toast 와 대칭)
6. **banner-multi-shell-e2e** — desktop / mobile shell 두 곳에서
   ConnectionBanner 가 single-mount 임을 묶어 검증
7. **ios-banner-screenshot** — iOS safe-area-inset 환경 (Playwright
   `--device='iPhone 13'`) 에서 banner 가 notch 회피 capture

Round 0 산출물: 7건 fix-forward commit + 회귀 spec 보강 + develop merge.

### 8 Dimensions (040 와 동일, 진행 순서 유지)

1. **Visual consistency** — DS tokens 사용 일관성 (raw hex / px 금지),
   page-scoped CSS / inline 정합성, 컴포넌트 변형 일관성
2. **Accessibility** — ARIA / focus order / 키보드 nav / screen reader,
   axe-core 정적 audit
3. **Error / Empty / Loading states** — offline banner, skeleton,
   send 실패 retry, 401/5xx fallback
4. **Edge cases** — 매우 긴 메시지 (10k chars), 한국어 IME 조합 send,
   다중 첨부 max+1, `:emoji:` 텍스트 충돌, mention not-found, URL
   preview, 코드 블록, 다중 탭
5. **모바일 viewport** — 375x667 / 414x896, touch ≥ 44px, swipe, IME,
   safe-area, address-bar collapse
6. **Channel messages** — composer / list / scroll / unread / typing /
   mention / reaction / hover actions
7. **DMs** — workspaceless flow, presence dot (041 신규), list 정렬 +
   미읽음, history pagination, participant metadata
8. **Performance** — Lighthouse 인프라 부재 그대로 → 정성 audit 만
   (bundle size delta vs 041, scroll 체감, WS reconnect 시간 stopwatch)

### Round per dimension (040 와 동일 8 step)

1. AUDIT (데스크톱 + 모바일, `042-round-N-<dim>.md` 기록)
2. IDENTIFY (BLOCKER/HIGH/MED/LOW)
3. FIX (BLOCKER + HIGH only, MED+ 는 TODO(task-042-follow) 이월)
4. REGRESSION SPEC (각 fix 마다 1개 이상)
5. VERIFY (`pnpm verify` + 영향 spec green)
6. DECIDE (다음 round 필요 여부)
7. DEVELOP MERGE (round 단위)
8. PROGRESS LOG (`042-round-N-<dim>.md` + matrix)

### Dimension 진행 순서

040 와 동일: Visual → A11y → Error/Empty/Loading → Edge → Mobile →
Channel → DM → Performance.

### 수렴 종료 조건

- 같은 dimension 2 round 연속 0 BLOCKER + 0 HIGH → dimension 완료
- 모든 8 dimension 완료 → loop 종료
- 또는 누적 24 round 도달 → cap 종료

종료 후 develop → main auto-promote 1회 + 통합 FINAL REPORT.

### Pane 1 auto-forward — 20번째 (마지막만)

Round 별 mini-progress 는 pane 0 안에서만. Round 0 완료도 pane 0
내부 로그. 최종 통합 REPORT 만 pane 1 으로 forward.

## Scope (OUT)

- lighthouse-ci 인프라 (미래 별도 task)
- virtualization (미래 별도 task)
- 새 feature
- 아키텍처 / 도메인 모델 변경
- DS 4파일 (`tokens.css` / `components.css` / `mobile.css` / `icons.css`) 수정
- MED+ 의 일괄 해결 — TODO(task-042-follow-\*) backlog 로
- 채널/DM 외 영역 — 040 와 동일 (단, 채널/DM 흐름에 영향 주는 spot fix 허용)
- 새 컴포넌트 / 새 view / 새 페이지
- BE 도메인 신규 endpoint
- E2E framework / Playwright config 전면 개편
- Bundle splitting 전면 재구성
- Optimistic update 도입 (skeleton 패턴 유지)

## Acceptance Criteria (mechanical)

- `pnpm verify` green (모든 round 끝나고 최종)
- Round 0 의 7건 follow 모두 처리 또는 명시 이월 (이월 시 사유)
- 8 dimension 각각 매트릭스에 결과 기록 (완료 또는 cap-stopped)
- 모든 BLOCKER + HIGH 해결 또는 명시적 이월 (TODO(task-042-follow-\*) +
  REPORT 에 reason)
- 회귀 spec: 각 fix 마다 1개 이상 추가 또는 기존 spec 보강
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (`git diff` 0)
- Round log: `docs/tasks/042-round-N-<dim>.md` 누적 (round 수 만큼) +
  `042-round-0-follow-absorb.md`
- 3 artefacts: `042-*.md` (task contract), `042-*.PR.md`,
  `042-*.review.md`
- 1 eval: `evals/tasks/053-polish-loop-5.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge (round 별) → main auto-promote (loop 종료 후 1회)
- `.deploy/audit.jsonl` 위치는 `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`
  (memory: `reference_deploy_audit_location.md`) — last entry `exitCode=0`
  - sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 20번째** (loop 종료 후 통합 REPORT)
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - **Round 0 결과 표** (7건 follow → 처리/이월)
  - **Dimension matrix** (8 × round 결과 표 — round 수, BLOCKER 처리,
    HIGH 처리, MED+ 이월 수, 회귀 spec 추가 수)
  - 누적 fix commit 표 (commit SHA → dimension → 요약)
  - 누적 회귀 spec 표 (파일 경로 → cover 하는 fix)
  - 040 ↔ 042 변화 요약 (같은 dim 에서 새로 발견된 issue 가 있었는지)
  - Performance 정성 baseline (bundle size delta, scroll 체감, WS
    reconnect stopwatch)
  - 데스크톱 + 모바일 핵심 흐름 capture (각 dimension 1-2장)
  - 이월 TODO(task-042-follow-\*) 목록
  - Round 총 수 + wall clock 총합
  - DS 4파일 git diff 0 증거 (md5 비교)
- Feature branch retained

## Prerequisite outcomes

- 040 (PL4, `037c71d`) + 041 (sweep, `17c8ab4`) merged + deployed
- 채널 + DM critical path 회귀 spec 누적 (040 8건 + 041 4-5건)
- ConnectionBanner / sendFailureToast / clampAttachments / DM presence dot
- 040 의 `.task-040-ds-baseline.txt` (DS md5 baseline) 그대로 사용
- input-label-guard 정적 audit harness (041 확장본)
- 026/028 polish harness

## Design Decisions

### Round 0 의 의의

041 follow 7건은 모두 review M/H 의 잔여로 PL5 dim audit 의 prerequisite.
먼저 정리 안 하면 dim audit 중 같은 issue 가 BLOCKER/HIGH 로 다시
잡혀 노이즈. Round 0 은 audit 없이 fix-forward 만.

### 040 와 같은 8 dim 유지

사용자 의도가 채널/DM 중심 + "여러번 반복". 새 dim 추가 (search /
notifications / auth) 는 scope 확장이라 다음 PL 에 양보. 같은 dim
두 번 도는 게 prod 운영 후 발견되는 잠재 issue 노출에 효과적.

### Performance 정성 audit

lighthouse-ci 인프라 부재 그대로. 정량 SLO 미달은 측정 자체가 불가
하므로 R8 은 정성 (bundle size delta, scroll 체감, WS reconnect
stopwatch) 만. 정량은 미래 별도 task.

### 040 의 결과 비교

040 가 41분 / 8 round 로 빠르게 수렴됐다. 042 도 비슷한 cycle 예상.
새 issue 가 거의 없으면 dim 별 1 round (audit + 0 fix + confirm-round)
로 끝나고 8 round 안에 마무리. 새 issue 가 많으면 cap 24 도달 가능.

### Round 0 의 spec 보강

7건 fix 마다 회귀 spec 1개 이상. 특히:

- jsdom-testing-env: input-label-guard 가 `<Input />` 같은 capital
  컴포넌트도 cover (audit 자체 시드)
- presence-memo: render count 를 mock 으로 검증
- composer-race-fix: 함수형 setState 호출 검증
- mutation-unmount-cleanup: unmount 후 setState warning console
  부재 검증
- delete-success-toast: 성공 path 의 toast push 검증
- banner-multi-shell-e2e: dual shell 마운트 시 single-mount
- ios-banner-screenshot: Playwright iPhone 13 device emulation

### Visual consistency 의 새 baseline

041 의 inline-px 71% 감소 후 baseline 새로 잡음. R1 audit 시 잔존
4건 (모두 합법 0px / 360px / 1px) 외 새로 들어온 raw px 발견 시
fix.

### Mobile 의 414x896 추가 e2e

040 R5 에서 신규 추가된 viewport-414-shell.polish.e2e.ts 가 baseline.
R5 audit 에서 다른 모바일 surface 확장 (414 + 375 + 768 portrait
태블릿 정도 cover).

### DS source of truth 무수정

040 / 041 와 동일. md5 baseline (`.task-040-ds-baseline.txt`) 재사용.

### 자율 종료 vs 사용자 개입

040 동일. cap 24 + 2-round 0-issue convergence + VERIFY 3 fail
중단 + 사용자 가설 질문.

## Non-goals

- 새 feature
- lighthouse-ci 인프라
- virtualization
- 아키텍처 / 모델 변경
- DS 4파일 수정
- 채널/DM 외 영역 large fix
- 모든 MED+ 일괄 해결
- 새 dimension 추가
- 새 컴포넌트 / 페이지
- E2E framework 변경
- Optimistic update 도입
- 신규 BE endpoint

## Risks

- **Round 0 의 7건이 한 round 안에 다 안 끝남**: 흡수 round 가 늘
  어나면 dim audit 시작이 늦음. cap 으로 round 0a / 0b 분리 가능
  (각 fix 가 독립이라 분리 비용 작음)
- **040 와 같은 8 dim 가 redundant 일 수 있음**: 040 fix 가 효과
  적이었으면 같은 dim 에서 새 issue 거의 없을 것 — 그 경우 빠른
  convergence 로 정상. redundant audit 비용은 audit 자체가 가벼워
  (Playwright 시뮬 1-2회) 무시 가능
- **VERIFY 누적 실패**: 040 와 동일 — 3 round fail 시 사용자 질문
- **Performance 정량 부재**: prod 환경에서 사용자 체감 미달 가능
  → R8 정성 audit 에서 명시 이월 + lighthouse-ci task 우선순위
  높임
- **DS baseline drift**: 040~041 의 md5 baseline 이 042 시작 시점에
  변경됐을 가능성 (다른 task 가 우회 변경) — Round 0 시작 전 md5
  재확인. 변경됐으면 BLOCKER 로 보고
- **041 follow 흡수가 dim audit 의 baseline 변형**: presence-memo
  fix 가 R7 DM audit 의 baseline 바꿈 등. Round 0 끝나고 매 dim
  audit 은 새 baseline 위에서
- **Pane 1 auto-forward 20 milestone**: 정상 progression. 별도 risk 없음
- **이월 TODO 누적**: 040 11건 + 041 7건 + 042 N건 → 누적 backlog
  관리 필요. 042 종료 시 통합 backlog 표 정리

## Progress Log

_Implementer 채움 — round 별 entry 추가_

- [ ] UNDERSTAND (040 round logs, 041 review.md 의 H/M, 041 follow
      7건 위치, ConnectionBanner / useDmPresence / clampAttachments
      현 구조, DS baseline md5 재확인, input-label-guard audit 결과)
- [ ] PLAN approved (Round 0 + 8 dim 진행 순서 + cap 명시)
- [ ] SCAFFOLD (Round 0 follow 7건 stub spec, dimension matrix
      template, audit 자동화 스크립트 재사용)
- [ ] LOOP
  - [ ] Round 0 — 041 follow 흡수 (7건)
  - [ ] Round 1 — Visual consistency
  - [ ] Round 2 — Accessibility
  - [ ] Round 3 — Error / Empty / Loading
  - [ ] Round 4 — Edge cases
  - [ ] Round 5 — Mobile viewport
  - [ ] Round 6 — Channel messages
  - [ ] Round 7 — DMs
  - [ ] Round 8 — Performance (정성)
  - [ ] (확정 round — 같은 dim 2 round 0-issue convergence 검증)
  - [ ] (필요 시 round 9 ~ 24)
- [ ] VERIFY (loop 종료 시 cumulative `pnpm verify` + e2e + DS md5
      baseline 일치)
- [ ] OBSERVE (Round 0 매핑, dimension matrix, 040 ↔ 042 비교, fix
      commit 표, 누적 backlog)
- [ ] REFACTOR
- [ ] REPORT (develop → main auto-promote via webhook → 통합 FINAL
      REPORT auto-printed + **pane 1 auto-forwarded 20th**)
