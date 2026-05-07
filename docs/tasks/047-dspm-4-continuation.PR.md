# Task 047 — DSPM-4 Continuation (96-row baseline) PR notes

> 누적 PR-style 요약. 9 iteration 가능 (cap 10), 96 row matrix 위에서
> 79.95% → 90% 도달 + HIGH=0 진짜 fix 가 목표.

## Branch

- `feat/task-047-dspm-4-continuation` (생성, push 예정)
- 시작 base: main `0ab2837` (046 closing docs)
- 마지막 code 변경 시점 main: `f268772` (046 iter 8)
- 복원지점: tag `v0.46-restore-point` + branch `restore-point/main-0ab2837`

## Iteration 별 commit + deploy 표

(loop 진행 중 채움)

| Iter | 처리 항목 | feat sha | main sha | exitCode | /readyz |
| ---- | --------- | -------- | -------- | -------- | ------- |

## 046 → 047 carry-over 처리 (iter 0, BLOCKER 게이트)

| ID         | 항목                                             | 상태 | commit | 회귀 spec |
| ---------- | ------------------------------------------------ | ---- | ------ | --------- |
| HIGH-046-A | Thread subscribe channel ACL guard               | TBD  | TBD    | TBD       |
| HIGH-046-B | @here e2e payload (schema + propagation)         | TBD  | TBD    | TBD       |
| MED-046-1  | IPv6 unspecified expanded `0:0:0:0:0:0:0:0` 차단 | TBD  | TBD    | TBD       |
| MED-046-2  | 6to4 (`2002::/16`) blanket block                 | TBD  | TBD    | TBD       |
| MED-046-3  | Migration `CREATE INDEX CONCURRENTLY` convention | TBD  | TBD    | TBD       |
| MED-046-4  | DnD `validate` raw Error → DomainError           | TBD  | TBD    | TBD       |
| MED-046-5  | SSRF hex-strict per group (defense-in-depth)     | TBD  | TBD    | TBD       |
| 모바일 4   | Section I production code scope (분할 ship)      | TBD  | TBD    | TBD       |

## Iteration 1~N 처리 표

(loop 진행 중 채움)

## 회귀 spec 누적 표

(loop 진행 중 채움)

## 매트릭스 변화 표

| Phase                   | Row | HIGH 갭 | Score (단순) | Score (HIGH×2) |
| ----------------------- | --- | ------- | ------------ | -------------- |
| 046 종료 (baseline)     | 96  | 0       | 79.95%       | 79.95%         |
| 047 iter 0 (carry-over) | 96  | TBD     | TBD          | TBD            |
| 047 종료                | 96  | 0       | TBD          | TBD            |

## 종료 사유 (loop 종료 후 채움)

- ❌/✅ (1) score ≥ 90% AND HIGH = 0 (real fix only)
- ❌/✅ (2) 누적 10 iteration cap
- ❌/✅ (3) 2 iteration 연속 score 변동 < 1pp

## 이월 TODO

(loop 종료 후 채움)
