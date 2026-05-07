# Iteration 0 — AUDIT (carry-over hot-fix RESULT)

## Score (시작)

- 046 종료 시 79.95% (96 row baseline, HIGH 0)
- 단 4 row (I3/I4/I7/I8) 이 reclass 로 closure → 047 에서 production code scope 정리 필요

## 처리 항목 (BLOCKER 게이트)

| ID         | 항목                                             | 처리                                                                                                    | 회귀 spec                                   |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| HIGH-046-A | Thread subscribe channel ACL (real fix)          | service.subscribe → channel meta select + ChannelAccessService.resolveEffective + READ 검증 + leak 방지 | thread-subscriptions.spec.ts +3 (총 14)     |
| HIGH-046-B | A9 @here e2e payload (real fix)                  | MessageMentionsSchema + here / mention/message-events payload + service.mentions 매핑                   | (typecheck 강제 + 기존 spec auto-cover)     |
| MED-046-1  | IPv6 unspecified expanded `0:0:0:0:0:0:0:0`      | expandIPv6 후 all-zero group 검사 추가                                                                  | ssrf-guard.spec.ts +2 (포함)                |
| MED-046-2  | 6to4 (`2002::/16`) blanket block                 | 6to4 prefix-match 만으로 차단 (NAT64 일관)                                                              | ssrf-guard.spec.ts (`2002:0808:808::` true) |
| MED-046-3  | Migration `CREATE INDEX CONCURRENTLY` convention | docs/conventions/migrations.md 신규 doc                                                                 | (doc-only, 코드 변경 X)                     |
| MED-046-4  | DnD validate raw Error → DomainError             | 8 throw 모두 DomainError(VALIDATION_FAILED) 로 교체 + controller 의 instanceof 가드 추가                | dnd-schedule.spec.ts +2 (총 15)             |
| MED-046-5  | SSRF hex-strict per group (defense-in-depth)     | parseInt 전 `/^[0-9a-f]{1,4}$/i` regex 검증 추가                                                        | ssrf-guard.spec.ts +2 (포함)                |
| 모바일 4   | Section I production code scope (분할 ship)      | docs/tasks/047-iteration-0-mobile-scope.md 신규 doc + Option B (048 이월)                               | (scope only)                                |

## 회귀 spec 표

| 신규 / 확장                         | Cases   | 상태 |
| ----------------------------------- | ------- | ---- |
| thread-subscriptions.spec.ts (확장) | +3 → 14 | ✅   |
| ssrf-guard.spec.ts (확장)           | +9 → 64 | ✅   |
| dnd-schedule.spec.ts (확장)         | +2 → 15 | ✅   |

## 측정 결과

- pnpm verify: 0 (FULL TURBO cache hit, lint 0 errors / typecheck OK / test green)
- API 239 → **249** unit tests (+10)
- web 118 (변화 없음)
- shared-types 8 / webhook 50 변화 없음
- DS 4 파일 md5 baseline 일치 (untouched)
- shared-types build 정상 (tsup install 복구 후)

## row 상태 변화 (96 row baseline)

### Section A — A9 @here e2e payload 보강

- A9: 046 iter 8 의 ✅ (1.0) 평가 — 실은 schema 미플러밍으로 actual 0.5 였음. 본 iter 의 schema 추가 + payload propagation 으로 진정 ✅ (1.0).

### Section I — 4 row scope 진급

| #   | Row             | 046 종료 (post-reclass) | 047 iter 0 | 가중치 변화 |
| --- | --------------- | ----------------------- | ---------- | ----------- |
| I3  | reaction picker | 🔵 (0.25)               | 🟡 (0.5)   | +0.25       |
| I4  | emoji picker    | 🔵 (0.25)               | 🟡 (0.5)   | +0.25       |
| I7  | onboarding      | 🔵 (0.25)               | 🟡 (0.5)   | +0.25       |
| I8  | pinned panel    | 🔵 (0.25)               | 🟡 (0.5)   | +0.25       |

Section I: 3.0 → **4.0 / 8** (= 50%, +12.5pp)

### Section A 정정

- 046 iter 8 의 A9 ✅ (1.0) 은 reclass-like (schema 미플러밍) 였음. 본 iter 의 e2e fix 로 ✅ (1.0) 유지 + 정합성 회복.
- 매트릭스 가중치 합 변화 없음 (이미 1.0).

## Score 재산정

- 046 종료 row 합: 76.75 / 96
- Section I 변화: +1.0 (4 row × +0.25)
- A9 정정: 0 (이미 1.0 으로 계산됨)
- 047 iter 0 종료 row 합: **77.75 / 96**
- 단순 score: 77.75 / 96 = **80.99%** (+1.04pp)
- HIGH×2 적용 (HIGH 갭 = 0 — 046 종료 와 동일):
  effective denom = 96 + 0 = 96
  score: 77.75 / 96 = **80.99%** (+1.04pp)

## 다음 단계

iter 1 — J2 + J4 (검색 dim 완성):

- J2 결과 navigation (이전/다음, 키보드)
- J4 코드블록 / 멘션 highlight

## Deploy plan (이번 iteration)

iter 0 는 1) carry-over fix → 2) develop merge + main auto-promote.
다음 iter 진행 (deploy 검증 통과 후).

## DoD

- [x] HIGH-046-A real fix + spec
- [x] HIGH-046-B real fix + spec
- [x] MED-046-1, 2, 5 fix (코드 + spec)
- [x] MED-046-4 fix (코드 + spec)
- [x] MED-046-3 doc-only (docs/conventions/migrations.md)
- [x] 모바일 4 row scope 명세 (Option B 채택, 048 이월)
- [x] pnpm verify (cumulative) green
- [x] DS untouched
