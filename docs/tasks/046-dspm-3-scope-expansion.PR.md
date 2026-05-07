# Task 046 — DSPM-3 + Scope Expansion (PL Meta-Loop) PR notes

> 누적 PR-style 요약. iteration 별 commit 표 / 매트릭스 변화 / 회귀 spec
> 표를 본 문서에 누적합니다. FINAL REPORT 는 별도 `046-FINAL-REPORT.md`.

## Branch

- `feat/task-046-dspm-3-scope-expansion` (생성, push 예정)
- 시작 base: main `707af0a` (045 closure)
- 복원지점: tag `v0.45-restore-point` + branch `restore-point/main-707af0a`

## Iteration 0 — Carry-over hot-fix (BLOCKER 게이트)

### 045 reviewer carry-over

| ID     | 항목                                | 상태 | commit | 회귀 spec |
| ------ | ----------------------------------- | ---- | ------ | --------- |
| HIGH-1 | SSRF-IPv6-mapped-variant + NAT64    | TBD  | TBD    | TBD       |
| HIGH-2 | GDM members endpoint                | TBD  | TBD    | TBD       |
| MED-1  | status-broadcast-throttle           | TBD  | TBD    | TBD       |
| MED-2  | mute-filter-tx-strict (deprecation) | TBD  | TBD    | TBD       |
| MED-5  | customStatus in members serializer  | TBD  | TBD    | TBD       |
| MED-6  | live-shell-visual-baseline (시드)   | TBD  | TBD    | TBD       |

(MED-3 = no action / MED-4 = no action — reviewer 결정)

## Iteration 1 — Matrix expansion (audit only)

신규 8 dimension row 추가 → score 일시 하락 측정. deploy 없음.

## Iteration 2~N

(loop 진행 중 채움)

## 회귀 spec 누적 표

(loop 진행 중 채움)

## 매트릭스 변화 표

| Phase                | Row 수 | Score |
| -------------------- | ------ | ----- |
| 045 종료 (baseline)  | 60+    | ≈ 95% |
| 046 iter 1 (확장 후) | TBD    | TBD   |
| 046 종료             | TBD    | TBD   |
