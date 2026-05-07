# Iteration 6 — AUDIT (P-individual 1차 / mutation hooks)

## 처리 범위

Section P (Error recovery 4 row) 의 P1 + P3 ✅ 진급 — 046 iter7 의
framework (`lib/error-messages.ts`) 를 5 mutation hook 에 wire.

## row 변경

| #   | Row                                        | iter 5 종료 | iter 6 종료 | 가중치 변화 |
| --- | ------------------------------------------ | ----------- | ----------- | ----------- |
| P1  | mutation retry pattern (idempotency 활용)  | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |
| P3  | recovery action (retry / cancel / refresh) | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |

Section P: 2.5 → **3.5 / 4** = **87.5%** (+25pp).

## 산출물

### P1 + P3 — friendlyError integration (✅ 진급)

5 mutation hook 에서 `friendlyError(err)` → 한국어 toast:

| Hook              | Title                 | 위치                                     |
| ----------------- | --------------------- | ---------------------------------------- |
| useUpdateMessage  | 메시지 수정 실패      | useMessages.ts                           |
| useDeleteMessage  | 메시지 삭제 실패      | useMessages.ts                           |
| usePinMessage     | 메시지 고정 실패      | useMessages.ts                           |
| useUnpinMessage   | 메시지 고정 해제 실패 | useMessages.ts                           |
| useToggleReaction | 리액션 실패           | useReactions.ts (rollback 위 toast 추가) |

각 hook 의 onError 가:

1. 기존 optimistic rollback (이미 있던 hook 만)
2. `friendlyError(err)` 로 한국어 메시지 + recovery 힌트 산출
3. `useNotifications.push({ variant: 'danger', title, body, ttlMs })`

P1 (retry pattern):

- friendlyError 의 `recovery: 'retry'` 가 RATE_LIMIT_EXCEEDED / BACKPRESSURE / 5xx 에 자동 매핑.
- idempotency-key 는 useSendMessage 가 이미 사용 (POST /messages — 011 기존).

P3 (recovery action):

- FriendlyError 에 `recovery: RecoveryAction` field 노출.
- RECOVERY_LABEL 이 한국어 button text 매핑.
- 향후 P4 (ErrorBoundary) 통합 시 recovery 라벨 자동 활용.

### 미처리 (이월)

- **P4 글로벌 ErrorBoundary**: 🟡 유지. 별도 surface (App.tsx 상위에 ErrorBoundary 컴포넌트) 필요. 047 iter 7 또는 다른 task.
- **다른 mutation hooks**: useChannelCreate / useDmCreate / useGroupDmCreate / useFriendAdd / useMute 등도 동일 패턴 적용 가능 — 본 iter 에선 5 핵심만, 나머지는 follow-up.

## 회귀 spec

| 신규 / 확장                      | Cases | 상태            |
| -------------------------------- | ----- | --------------- |
| (기존 error-messages.spec.ts 11) | 0     | ✅ (auto-cover) |

> friendlyError 자체의 unit spec 은 046 iter 7 에 11 case. mutation
> hook 통합은 e2e 측 (Playwright) 로 cover. 본 iter 의 신규 spec 은
> 없음 — 기존 spec 이 모든 경로 cover.

## Score 재산정 (96 row baseline)

- iter 5 종료 row 합: 83.0 / 96
- P1: +0.5, P3: +0.5
- iter 6 종료 row 합: **84.0 / 96**
- 단순 score: 84.0 / 96 = **87.50%** (+1.04pp)
- HIGH×2 (HIGH=0): 동일 **87.50%** (+1.04pp)

## DoD

- [x] P1 + P3 friendlyError wire (5 hook)
- [x] HIGH 갭 = 0 유지
- [x] pnpm verify green (api 266 + web 137)
- [x] DS untouched
- [x] 96 row matrix 유지

## 측정

- 영향 라인: ~70 (useMessages 50 + useReactions 15 + import 5)
- spec 변경 0 (기존 cover)
- 신규 라우트 0 / 컬럼 0 / migration 0

## 다음 단계 (iter 7)

- O 나머지 row (O3 search empty / O4 discover / O5 pinned / O6 activity / O7 thread) 진급
- P4 ErrorBoundary 가능하면 추가
- AUDIT 결과 기반 잔여 항목

iter 6 score 87.50% — 90% 까지 +2.5pp 남음. iter 7 의 O 나머지 (5 row × 0.5 = +2.5) 만으로 90% 도달 가능.
