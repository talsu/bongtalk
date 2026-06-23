# Round 0 — 041 follow 흡수 (선행)

dim audit 시작 전, 041 review 의 6 MED + 1 잔여 H3 (총 7건) 을 fix-forward 일괄 처리.

## 처리 / 이월

| ID  | follow item                          | 처리                                                                                                                                             | 회귀 spec                                    |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| F1  | jsdom-testing-env (review H3 잔여)   | ✅ guard regex 에 capital-case (`<Input \|Textarea\|Select\|TextField>`) scan 추가, DS primitives 제외. CommandPalette `<Input>` aria-label 추가 | input-label-guard.spec.ts (확장)             |
| F2  | presence-memo (review M1)            | ✅ `useDmPresence` 에 signature dedup + useMemo 적용; `added`/`updated` 둘 다 cover; non-presence key 무시                                       | useDmPresence.spec.ts (5 tests)              |
| F3  | composer-race-fix (review M2)        | ✅ `pendingRef` + `jobsRef` 으로 latest state 읽음; 함수형 setJobs + ref mirror                                                                  | (기존 clampAttachments race spec 보강 cover) |
| F4  | mutation-unmount-cleanup (review M3) | ✅ `MessageItem` 에 `isMountedRef` + `safeSet` helper, 모든 mutation finally 가 unmount 안전                                                     | (R6 dim audit 에서 회귀 e2e 시점 검증)       |
| F5  | delete-success-toast (review M4)     | ✅ `MessageItem` delete 성공 시 success toast 추가 (실패와 대칭)                                                                                 | (R6 dim audit 에서 e2e)                      |
| F6  | banner-multi-shell-e2e (review M5)   | ✅ `banner-multi-shell.e2e.ts` 신규: 인증 후 desktop+mobile 각 shell 변형에서 single-mount 확인                                                  | banner-multi-shell.e2e.ts (e2e)              |
| F7  | ios-banner-screenshot (review M6)    | ✅ `banner-ios-safe-area.e2e.ts` 신규: Playwright iPhone 13 device + offline 시뮬 + padding-top 측정 + screenshot                                | banner-ios-safe-area.e2e.ts (e2e)            |

## 누적 spec 변화

| 종류 | 신규                                                   | 보강                                   |
| ---- | ------------------------------------------------------ | -------------------------------------- |
| unit | useDmPresence.spec.ts (5)                              | input-label-guard.spec.ts (regex 확장) |
| e2e  | banner-multi-shell.e2e.ts, banner-ios-safe-area.e2e.ts | (none)                                 |

## VERIFY

```
$ pnpm verify
... 19/19 successful, 0 errors, 59 warnings (pre-existing)
$ pnpm --filter @qufox/web test src/features/realtime/useDmPresence
... 5 passed
$ pnpm --filter @qufox/web test src/a11y/input-label-guard.spec.ts
... 1 passed
```

## DS 4파일 무수정

baseline (`.task-040-ds-baseline.txt`) 와 md5 100% 일치 (verify 시점).

## 다음 단계

R1 (Visual consistency) audit. 041 의 inline-px 71% 감소 baseline 위에서 신규 raw 값 검출.
