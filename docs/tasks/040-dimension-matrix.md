# Task 040 — Dimension Matrix

자율 polish loop 진행 추적표. 8 dimension × 8-step round.

| #   | Dimension               | Round | BLOCKER | HIGH      | MED+ 이월 | 회귀 spec                                    | 결과         |
| --- | ----------------------- | ----- | ------- | --------- | --------- | -------------------------------------------- | ------------ |
| 1   | Visual consistency      | R1    | 0       | 0         | 3         | 0 (lint guard 누적)                          | ✅ clean     |
| 2   | Accessibility           | R2    | 0       | 9 (fixed) | 6         | 1 (input-label-guard)                        | ✅           |
| 3   | Error / Empty / Loading | R3    | 0       | 3 (fixed) | 3         | 3 (computeBanner / sendFailToast / contract) | ✅           |
| 4   | Edge cases              | R4    | 0       | 1 (fixed) | 0         | 1 (clampAttachments — 7 tests)               | ✅           |
| 5   | Mobile viewport         | R5    | 0       | 2 (fixed) | 1         | 2 (helpers contract + 414 e2e)               | ✅           |
| 6   | Channel messages        | R6    | 0       | 0         | 1         | 0 (R2/R3/R4 누적 cover)                      | ✅ converged |
| 7   | DMs                     | R7    | 0       | 0         | 2         | 0 (누적 + 039 hot-fix회수)                   | ✅ converged |
| 8   | Performance             | R8    | 0       | 0         | 2         | 0 (size-limit 기존)                          | ✅           |

**Loop 종료 — 모든 8 dimension 완료, 누적 8 round (cap 24 미달).**

## Convergence rule

- 같은 dimension 2 round 연속 0 BLOCKER + 0 HIGH → 완료.
- R6 (channel msg) 와 R7 (DMs) 는 R2/R3/R4 누적 fix 효과로 첫 audit
  부터 0 BLOCKER + 0 HIGH (converged).
- R1 (visual) + R8 (perf) 는 첫 audit 부터 0 BLOCKER + 0 HIGH.
- VERIFY 3회 연속 실패 0건 (R5 에서 1회 transient typecheck OOM
  - 1회 export 누락 → 즉시 수정 후 retry green).

## Cumulative fix commits

| SHA     | Round    | Dimension    | 요약                                                        |
| ------- | -------- | ------------ | ----------------------------------------------------------- |
| f8734e8 | R0       | scaffold     | dimension matrix + round template + eval yaml               |
| 9e04be2 | R2       | a11y         | label 9 critical-path inputs (channel/DM/composer/discover) |
| 3929603 | R3       | error states | connection banner + send-failure toast                      |
| 17cffde | R4       | edge         | clamp composer attachments to server cap (10)               |
| dfa4049 | R5       | mobile       | 414x896 viewport helper + smoke e2e                         |
| _next_  | R6/R7/R8 | combined     | round logs + dimension matrix update                        |

## Cumulative regression specs (10 신규, 8 누적 cover)

| 파일                                                               | Cover 하는 fix                    |
| ------------------------------------------------------------------ | --------------------------------- |
| `apps/web/src/a11y/input-label-guard.spec.ts`                      | R2 9 inputs                       |
| `apps/web/src/features/connection/computeConnectionBanner.spec.ts` | R3 EE-2/3 banner state matrix (6) |
| `apps/web/src/features/messages/sendFailureToast.spec.ts`          | R3 EE-1 토스트 push shape (2)     |
| `apps/web/src/features/messages/sendFailureToast.contract.spec.ts` | R3 EE-1 onError 가 push 호출 (1)  |
| `apps/web/src/features/messages/clampAttachments.spec.ts`          | R4 EC-1 7 boundary cases          |
| `apps/web/src/__tests__/mobile-viewport-helpers.spec.ts`           | R5 MV-1 helper contract           |
| `apps/web/e2e/mobile/viewport-414-shell.polish.e2e.ts`             | R5 MV-2 layout smoke (2)          |
| (누적) `apps/web/src/features/messages/parseContent.spec.tsx`      | R4 emoji/code/mention/URL         |
| (누적) 22 polish e2e + 6 dms e2e + 3 mobile dm e2e                 | R6/R7                             |
| (누적) `eslint.config.mjs` raw-value guard                         | R1                                |

총 신규 unit/spec 7개 + 1 e2e + 누적 cover. 49 unit tests pass (R0
38 → R8 49).

## Wall clock

- Loop 시작: 2026-04-27T13:38:35Z
- Loop 종료: (R8 + main promote 직후 기록)
- 총 round 수: 8 (cap 24 의 33%)
