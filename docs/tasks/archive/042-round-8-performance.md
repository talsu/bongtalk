# Round 8 — Performance (정성)

Lighthouse-CI 인프라 부재로 정성 audit 만 (task spec OUT).

## AUDIT

### Bundle size (gzipped, vite build)

| chunk                 | 042 후   | 041 baseline | 상태                           |
| --------------------- | -------- | ------------ | ------------------------------ |
| initial entry + shell | 12.02 KB | ~12.0 KB     | budget 200 KB → 6.0% (Δ 0%)    |
| Shell chunk           | 17.26 KB | 17.29 KB     | budget 80 KB → 21.6% (Δ -0.2%) |
| vendor-react          | 53.36 KB | 53.36 KB     | budget 55 KB → 97.0% (Δ 0%)    |
| vendor-radix          | 29.69 KB | 29.69 KB     | budget 70 KB → 42.4% (Δ 0%)    |
| vendor-query          | 12.29 KB | 12.29 KB     | budget 35 KB → 35.1% (Δ 0%)    |
| vendor-socket         | 12.94 KB | 12.94 KB     | budget 30 KB → 43.1% (Δ 0%)    |

**모든 budget 미달** + 041 대비 변화 거의 없음 (0~-0.2%). 목표 ≤+5% 만족.

### Scroll 체감

R0 F2 (useDmPresence memo) 효과로 DM list 의 presence 변경 시 unnecessary re-render 제거 — 이론적으로 30 events/min × N rows 의 paint cost 가 0 으로. 정량은 prod 측정.

### WS reconnect stopwatch (정성)

`apps/web/src/lib/socket.ts` 의 `reconnectionDelay: 500ms`, `reconnectionAttempts: 10`, `reconnectionDelayMax: 5000ms`. 040 R3 의 ConnectionBanner 가 disconnected 상태를 즉시 표시 → 사용자에게 "재연결 중" 인지 시간 0.5-2s 안에 인지. 측정 인프라 부재로 정량은 미수행.

## IDENTIFY

| ID  | 내용                                 | 분류                                    |
| --- | ------------------------------------ | --------------------------------------- |
| P1  | bundle delta vs 041 ≤ 0.2%           | clean                                   |
| P2  | initial entry + shell budget 6% 사용 | clean (room 94%)                        |
| P3  | vendor-react 97% 도달 (변동 없음)    | LOW (next React minor 시 budget 재검토) |
| P4  | Lighthouse 인프라 부재               | OUT — task-040-follow-lighthouse-ci     |
| P5  | virtualization 부재 (DOM cost)       | OUT — 별도 task                         |

**0 BLOCKER, 0 HIGH.**

## FIX

해당 없음.

## REGRESSION SPEC

`apps/web/.size-limit.cjs` 가 build 마다 budget 검증 (CI 자동).

## VERIFY

```
$ pnpm build
... ✓ built in 6.50s
$ pnpm size
... 6 budgets all under limit
$ pnpm verify
... 19/19 successful
```

## DECIDE

R8 = 0. R7 = 0. 2 round 연속 0 → R8 converged. **모든 8 dim 완료**.

## PROGRESS

| Round | BLOCKER | HIGH | MED+ 이월                                     | 회귀 spec           |
| ----- | ------- | ---- | --------------------------------------------- | ------------------- |
| R8    | 0       | 0    | 2 (P4 lighthouse-ci, P5 virtualization — OUT) | 0 (size-limit 기존) |
