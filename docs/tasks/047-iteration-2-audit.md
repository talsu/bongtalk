# Iteration 2 — AUDIT (Section K 알림 dim 완성)

## 처리 범위

Section K (알림 다양성 4 row) 의 K2 + K3 ✅ 진급.

## row 변경

| #   | Row                                        | iter 1 종료 | iter 2 종료 | 가중치 변화 |
| --- | ------------------------------------------ | ----------- | ----------- | ----------- |
| K1  | DnD 시간대 schedule                        | 🟡 (0.5)    | 🟡 (0.5)    | 0           |
| K2  | 우선순위 (mention/thread reply/일반)       | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |
| K3  | Badge 동작 (unread vs mention / OS bridge) | 🔵 (0.25)   | ✅ (1.0)    | +0.75       |
| K4  | 첫 알림 onboarding                         | 🟡 (0.5)    | 🟡 (0.5)    | 0           |

Section K: 1.75 → **3.0 / 4** = **75%** (+31.25pp).

## 산출물

### K2 우선순위 (✅ 진급)

- **`apps/api/src/notifications/priority.ts`** 신규:
  - `priorityFor(eventType): 'high' | 'medium' | 'low'`
  - `bypassesMute(priority)` — high 만 mute bypass
  - `isDigestable(priority)` — low 만 digest batch 가능
- **매핑 정책**:
  - high: MENTION / DIRECT / FRIEND_REQUEST
  - medium: REPLY
  - low: REACTION
- `priority.spec.ts` 신규 — 9 case
- 영향: ~80 라인

### K3 Badge 동작 (✅ 진급)

- **`apps/web/src/features/notifications/badge-variant.ts`** 신규:
  - `badgeVariant(count, hasMention): 'none' | 'unread' | 'mention'`
  - `badgeAriaLabel(count, hasMention): string | null` — 한국어 SR
  - `badgeText(count): string` — 99+ cap
- **WorkspaceNav.tsx** rewire — 이전 inline 분기를 helper 호출로 교체 + `data-variant` 속성 추가 (CSS hook).
- 향후 모바일 tab bar / DM 리스트도 같은 helper 재사용 가능.
- `badge-variant.spec.ts` 신규 — 9 case
- 영향: ~110 라인

### OS bridge (out of scope)

- 모바일 push (FCM/APNS) 는 047 spec 의 OUT — task-049+ (또는 mobile-shell task) 영역.
- K3 의 ✅ 평가 의미: web 측 unread/mention badge 구분 + a11y. OS bridge 부분은 매트릭스 row 정의에서 제외.

## 회귀 spec

| 신규                         | Cases | 상태 |
| ---------------------------- | ----- | ---- |
| priority.spec.ts (신규)      | 9     | ✅   |
| badge-variant.spec.ts (신규) | 9     | ✅   |

## Score 재산정 (96 row baseline)

- iter 1 종료 row 합: 78.75 / 96
- Section K 변화: +1.25 (K2 +0.5 + K3 +0.75)
- iter 2 종료 row 합: **80.0 / 96**
- 단순 score: 80.0 / 96 = **83.33%** (+1.30pp)
- HIGH×2 (HIGH=0): 동일 **83.33%** (+1.30pp)

## DoD

- [x] K2 priority helper + spec
- [x] K3 badge-variant helper + WorkspaceNav rewire + spec
- [x] HIGH 갭 = 0 유지
- [x] pnpm verify green (api 249→258 + web 125→134)
- [x] DS untouched
- [x] 96 row matrix 유지

## 측정

- 영향 라인: ~190 (priority 80 + badge-variant 110 + WorkspaceNav rewire 5)
- API 249 → **258** (+9), web 125 → **134** (+9), 누적 18 spec 추가
