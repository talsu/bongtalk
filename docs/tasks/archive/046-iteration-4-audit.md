# Iteration 4 — AUDIT (notification diversity, Section K, single-iter)

## 처리 범위

Section K (알림 다양성 4 row) 의 HIGH 갭 2건 closure + 부분 row 2건 유지.

- **K1 DnD weekly schedule (HIGH)**: User.dndSchedule (jsonb) +
  DndScheduleService (validate / isActive) + GET/PATCH /me/dnd-schedule.
- **K4 첫 알림 onboarding (HIGH)**: User.notificationOnboardingShown
  (boolean) + GET/PATCH /me/notification-onboarding (idempotent mark).
- **K2 우선순위**: 기존 notification preferences 의 eventType 분기가 이미
  처리. 매트릭스 🟡 유지.
- **K3 Badge OS bridge**: 모바일 push (FCM/APNS) 가 task scope OUT 이라
  매트릭스 🔵 유지.

## row 상태 변화 (Section K)

| #   | Row                                        | iter 1 상태 | iter 4 상태            | 가중치 변화 |
| --- | ------------------------------------------ | ----------- | ---------------------- | ----------- |
| K1  | DnD 시간대 schedule                        | ❌ HIGH (0) | 🟡 (0.5) **HIGH→해소** | +0.5        |
| K2  | 우선순위 (mention/thread reply/일반)       | 🟡 (0.5)    | 🟡 (0.5)               | 0           |
| K3  | Badge 동작 (unread vs mention / OS bridge) | 🔵 (0.25)   | 🔵 (0.25)              | 0           |
| K4  | 첫 알림 onboarding                         | ❌ HIGH (0) | 🟡 (0.5) **HIGH→해소** | +0.5        |

소계: 0.75 → **1.75 / 4** (= 43.75%, +25pp)

**HIGH 갭 10 → 8 (-2)**.

## 데이터 모델

### Migration

`20260507120000_add_user_dnd_and_notification_onboarding`:

```sql
ALTER TABLE "User" ADD COLUMN "dndSchedule" JSONB;
ALTER TABLE "User" ADD COLUMN "notificationOnboardingShown" BOOLEAN NOT NULL DEFAULT false;
```

Reversible: DROP COLUMN.

### dndSchedule shape

```ts
{ days: [{ day: 0..6 (Sun..Sat), startMin: 0..1439, endMin: 0..1439 }] }
```

- start>end → overnight (예: 23:00 → 07:00)
- 같은 day 의 entries 는 OR (어느 하나라도 활성이면 DnD)
- null = no schedule (disabled)
- cap 14 entries / user

## API 변경

### 신규 endpoint

- `GET /me/dnd-schedule` → `{ schedule: DndSchedule | null }`
- `PATCH /me/dnd-schedule` body `{ schedule: DndSchedule | null }` → `{ schedule }`
  - rate: 30/min/user
  - validation: shape + ranges + cap
- `GET /me/notification-onboarding` → `{ shown: boolean }`
- `PATCH /me/notification-onboarding` (idempotent) → `{ shown: true }`

## 회귀 spec

| 신규                                      | Cases | 상태 |
| ----------------------------------------- | ----- | ---- |
| dnd-schedule.spec.ts (신규)               | +13   | ✅   |
| - validate                                | 7     | ✅   |
| - isActive (same-day / overnight / multi) | 6     | ✅   |

## Score 재산정 (확장 매트릭스 96 row)

- iter 3 종료 row 합: 69.0 / 96
- Section K 변화: +1.0
- iter 4 종료 row 합: **70.0 / 96**
- 단순 score: 70.0 / 96 = **72.92%** (+1.04pp)
- HIGH×2 적용 (HIGH 10 → 8):
  effective denom = 96 + 8 = 104
  score: 70.0 / 104 = **67.31%** (+2.22pp)

iter 4 score recovery: **+1.04 ~ +2.22pp**. 누적 측면에서는 카운트
시점 잘못 계산 가능 — 각 iter 의 정확한 HIGH 추적은 매트릭스 row 의
HIGH 표시 (table) 기반으로 진행.

## DoD

- [x] K1 dndSchedule 컬럼 + service + API + spec
- [x] K4 onboarding 컬럼 + API
- [x] migration reversible
- [x] HIGH 2건 closure
- [x] pnpm verify green (213 unit tests, 이전 200)
- [x] DS untouched

## 측정

- 영향 라인: ~280 (svc 130 + ctrl 50 + spec 110 + module 6 + migration 14)
- API 213 unit tests (이전 200 → +13)
- 신규 라우트 4
- 신규 컬럼 2
- 신규 migration 1 (reversible)
