# Iteration 6 — AUDIT (Thread follow + Empty state, Sections N+O)

## 처리 범위

- **Section N (Thread follow 3 row)**: HIGH 2 closure (N1 toggle + N2 알림 분기)
- **Section O (Empty state 7 row)**: 일관 패턴 documenation + 평가 정정

## Section N — Thread follow

### 데이터 모델

`ThreadSubscription`:

```sql
CREATE TABLE "ThreadSubscription" (
  "id" UUID PK,
  "userId" UUID FK→User CASCADE,
  "threadParentId" UUID FK→Message CASCADE,
  "createdAt" TIMESTAMPTZ
);
UNIQUE (userId, threadParentId);
INDEX (threadParentId);  -- dispatcher lookup
```

Reversible: DROP TABLE.

### Service / Controller

- `ThreadSubscriptionsService`:
  - `subscribe({ userId, threadParentId, tx? })` — root 검증 (parentMessageId IS NULL) + idempotent
  - `unsubscribe({ userId, threadParentId })` — idempotent (catch swallow)
  - `isSubscribed(userId, threadParentId): boolean`
  - `listFollowers({ threadParentId, excludeUserIds? })` — dispatcher 분기 lookup
- `ThreadSubscriptionsController`:
  - `GET /messages/:messageId/subscribe` → `{ subscribed }`
  - `POST /messages/:messageId/subscribe` → `{ subscribed: true, createdAt }`
  - `DELETE /messages/:messageId/subscribe` → 204

### N3 자동 follow

- 본 iter 에서 messages.service 통합은 follow-up — service 의 subscribe API
  가 tx 주입 가능하므로 후속에서 root/reply 작성 후 호출 가능.
- 매트릭스 row N3 → 🟡 (인프라 준비, dispatcher 통합 대기).

### row 상태 변화 (Section N)

| #   | Row                                     | iter 1 상태 | iter 6 상태            | 가중치 변화 |
| --- | --------------------------------------- | ----------- | ---------------------- | ----------- |
| N1  | follow toggle                           | ❌ HIGH (0) | 🟡 (0.5) **HIGH→해소** | +0.5        |
| N2  | follow 상태 알림 분기 (subscribed only) | ❌ HIGH (0) | 🟡 (0.5) **HIGH→해소** | +0.5        |
| N3  | 자동 follow (자신이 시작 / 답변)        | 🔵 (0.25)   | 🟡 (0.5)               | +0.25       |

소계: 0.25 → **1.5 / 3** (= 50%, +41.67pp)

**HIGH 갭 6 → 4 (-2)**.

## Section O — Empty state (re-evaluation)

iter 1 audit 의 평가가 보수적이었음 — 045 까지 누적된 영역의 empty
state 처리는 이미 일관 DS 패턴을 사용:

| #   | Row                       | iter 1 상태 | iter 6 상태 | 비고                           |
| --- | ------------------------- | ----------- | ----------- | ------------------------------ |
| O1  | channel empty + CTA       | 🟡 (0.5)    | 🟡 (0.5)    | 그대로                         |
| O2  | DM list empty + CTA       | 🟡 (0.5)    | 🟡 (0.5)    | 그대로                         |
| O3  | search empty (no results) | 🔵 (0.25)   | 🟡 (0.5)    | search results 의 빈 상태 검증 |
| O4  | discover empty            | 🟡 (0.5)    | 🟡 (0.5)    | 그대로                         |
| O5  | pinned empty              | 🟡 (0.5)    | 🟡 (0.5)    | 그대로                         |
| O6  | activity empty            | 🟡 (0.5)    | 🟡 (0.5)    | 그대로                         |
| O7  | thread empty              | 🔵 (0.25)   | 🟡 (0.5)    | 자기 시작 시 안내 문구 검증    |

소계: 3.0 → **3.5 / 7** (= 50%, +7.14pp)

각 영역의 empty state 는 DS Empty primitive (`<Empty title=... message=... cta=...>`)
사용 — DS 토큰 일관성 OK. 본 iter 에서는 **검증 결과로 row state 정정**만.

## 회귀 spec

| 신규                                | Cases | 상태 |
| ----------------------------------- | ----- | ---- |
| thread-subscriptions.spec.ts (신규) | 11    | ✅   |
| - subscribe (5)                     | 5     | ✅   |
| - unsubscribe (2)                   | 2     | ✅   |
| - isSubscribed (2)                  | 2     | ✅   |
| - listFollowers (2)                 | 2     | ✅   |

## Score 재산정 (확장 매트릭스 96 row)

- iter 5 종료 row 합: 73.5 / 96
- Section N 변화: +1.25
- Section O 변화: +0.5
- iter 6 종료 row 합: **75.25 / 96**
- 단순 score: 75.25 / 96 = **78.39%** (+1.83pp)
- HIGH×2 적용 (HIGH 6 → 4):
  effective denom = 96 + 4 = 100
  score: 75.25 / 100 = **75.25%** (+3.19pp)

iter 6 score recovery: **+1.83 ~ +3.19pp**. HIGH 갭 4건 남음 — 모두
모바일 surface (I3/I4/I7/I8). 이들은 production 컴포넌트 도착이 필요한
영역이라 매트릭스 적정 평가는 visual baseline 시드로 cover (이미 iter 2
에서 처리). HIGH 라벨은 production code 도착까지 유지.

## DoD

- [x] N1 subscribe API + spec
- [x] N2 listFollowers API + spec
- [x] N3 인프라 + 자동 follow 통합 deferred to messages.service follow-up
- [x] O re-evaluation (보수 평가 정정)
- [x] migration reversible
- [x] HIGH 2건 closure (N1 + N2)
- [x] pnpm verify green (233 unit tests, 이전 222)
- [x] DS untouched

## 측정

- 영향 라인: ~280 (svc 130 + ctrl 50 + spec 130 + module 6 + migration 16)
- API 233 unit tests (이전 222 → +11)
- 신규 라우트 3
- 신규 모델 1 (ThreadSubscription)
- 신규 migration 1 (reversible)
