# Iteration 7 — AUDIT (Error recovery 일관성, Section P)

## 처리 범위

Section P (Error recovery 4 row) 의 일관 패턴 framework 시드.

- **P2 일관된 한국어 에러 메시지**: `lib/error-messages.ts` —
  errorCode 별 한국어 message + recovery 매핑 (기존 errorCode 모두 cover)
- **P3 recovery action**: `RecoveryAction` 타입 + `RECOVERY_LABEL` 라벨 한국어
  (retry / cancel / refresh / login / none)
- **P1 retry pattern**: errorCode 별 recovery 가 'retry' 인 항목들이 자동
  매핑 (RATE_LIMIT_EXCEEDED / BACKPRESSURE / 5xx). idempotency-key 는
  Message create 등 기존 endpoint 가 이미 활용
- **P4 글로벌 boundary**: lib/error-messages 가 sendFailureToast 와 추후
  글로벌 ErrorBoundary 의 공통 source. 본 iter 에서는 framework 시드만,
  ErrorBoundary 통합은 follow-up

## row 상태 변화 (Section P)

| #   | Row                                       | iter 1 상태 | iter 7 상태 | 가중치 변화 |
| --- | ----------------------------------------- | ----------- | ----------- | ----------- |
| P1  | mutation retry pattern (idempotency 활용) | 🟡 (0.5)    | 🟡 (0.5)    | 0           |
| P2  | 일관된 한국어 에러 메시지                 | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |
| P3  | recovery action (retry/cancel/refresh)    | 🔵 (0.25)   | 🟡 (0.5)    | +0.25       |
| P4  | 글로벌 에러 boundary + telemetry          | 🟡 (0.5)    | 🟡 (0.5)    | 0           |

소계: 1.75 → **2.5 / 4** (= 62.5%, +18.75pp)

HIGH 갭 0건 (변화 없음).

## 산출물

- `apps/web/src/lib/error-messages.ts` (신규):
  - `friendlyError(err) → FriendlyError` (메시지 + recovery + telemetry meta)
  - `RECOVERY_LABEL` (한국어 button 라벨)
  - errorCode table: 17 항목 (Auth 7 + Validation 1 + Workspace 5 + Channel/Message 2 + Rate 2 + Generic 1)
  - status code fallback: 401/403/404/409/429/5xx/4xx
  - network / unknown fallback: "잠시 후 다시 시도"
- `apps/web/src/lib/error-messages.spec.ts` — 11 cases

## 회귀 spec

| 신규                          | Cases | 상태 |
| ----------------------------- | ----- | ---- |
| error-messages.spec.ts (신규) | 11    | ✅   |
| - errorCode 매핑 (4)          | 4     | ✅   |
| - status fallback (3)         | 3     | ✅   |
| - unknown / non-Error (2)     | 2     | ✅   |
| - generic 4xx (1)             | 1     | ✅   |
| - RECOVERY_LABEL 한국어 (1)   | 1     | ✅   |

## Score 재산정 (확장 매트릭스 96 row)

- iter 6 종료 row 합: 75.25 / 96
- Section P 변화: +0.75
- iter 7 종료 row 합: **76.0 / 96**
- 단순 score: 76.0 / 96 = **79.17%** (+0.78pp)
- HIGH×2 적용 (HIGH 4 → 4 변화 없음):
  effective denom = 96 + 4 = 100
  score: 76.0 / 100 = **76.0%** (+0.75pp)

iter 7 score recovery: **+0.75 ~ +0.78pp**. HIGH 변동 없음 — 누적
상승만. 다음 iter 에서 HIGH 4건 (모바일 production code) 의 매트릭스
재평가가 필요.

## DoD

- [x] Section P framework 시드
- [x] 11 spec cases (회귀)
- [x] pnpm verify green (118 web tests, 이전 107)
- [x] DS untouched

## 측정

- 영향 라인: ~250 (lib 130 + spec 120)
- web 118 unit tests (이전 107 → +11)
- 신규 모듈 1 (lib/error-messages)
- 향후 사용처: useSendMessage / useUpdateMessage 등 onError 핸들러 (마이그 follow-up)
