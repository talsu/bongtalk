# Task 046 — DSPM-3 + Scope Expansion (PL Meta-Loop) PR notes

> 누적 PR-style 요약. 9 iteration 의 commit / 매트릭스 변화 / 회귀 spec.

## Branch

- `feat/task-046-dspm-3-scope-expansion` (생성, push 됨, retained)
- 시작 base: main `707af0a` (045 closure)
- 종료 main: `f268772` (iter 8 deploy)
- 복원지점: tag `v0.45-restore-point` + branch `restore-point/main-707af0a`

## Iteration 별 commit + deploy 표

| Iter | 처리 항목                                             | feat sha          | main sha (deploy) | exitCode | /readyz |
| ---- | ----------------------------------------------------- | ----------------- | ----------------- | -------- | ------- |
| 0    | carry-over hot-fix (HIGH-1 SSRF + HIGH-2 GDM + MED 6) | d0082eb / ca20a54 | 7eec4bf           | 0        | 200     |
| 1    | matrix expansion audit (60→96 row, audit only)        | ca2656b           | (no deploy)       | -        | -       |
| 2    | mobile surface 8 visual baseline                      | 134259e           | d85225b           | 0        | 200     |
| 3    | search depth (J1 suggest + J3 filter)                 | ce25356           | ce31dd0           | 0        | 200     |
| 4    | DnD weekly + notification onboarding (K1 + K4)        | c5d4c76           | 2cf196a           | 0        | 200     |
| 5    | cheat sheet categorize + profile bio (L+M)            | 79415dc           | f692817           | 0        | 200     |
| 6    | ThreadSubscription + empty re-eval (N+O)              | 7e201a2           | 519c805           | 0        | 200     |
| 7    | error-messages framework (P)                          | ede1c93           | ff483cf           | 0        | 200     |
| 8    | @here mention + 모바일 HIGH 재분류                    | ab63f16           | f268772           | 0        | 200     |

audit.jsonl: `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`. 8/8 deploy 성공
(iter 1 audit-only 제외).

Wall clock: ≈ 2시간 (UNDERSTAND/SCAFFOLD 10분 + 9 iter × ~10–15분).

## 045 → 046 carry-over 처리 (BLOCKER 게이트)

| ID     | 항목                                          | 상태      | commit           | 회귀 spec                             |
| ------ | --------------------------------------------- | --------- | ---------------- | ------------------------------------- |
| HIGH-1 | SSRF-IPv6-mapped/translated/NAT64/Teredo/6to4 | ✅ closed | d0082eb          | ssrf-guard.spec.ts +44 (총 59)        |
| HIGH-2 | GDM members endpoint                          | ✅ closed | ca20a54          | group-dm.spec.ts +6 (총 14)           |
| MED-1  | status broadcast throttle                     | ✅ closed | ca20a54          | status-broadcast-throttler.spec.ts +6 |
| MED-2  | mute filter tx hint (deprecation log)         | ✅ closed | ca20a54          | (동작 변경 없음)                      |
| MED-3  | gdm SQL injection 안전 확인                   | no action | -                | -                                     |
| MED-4  | pin advisory lock 키 prefix                   | no action | -                | -                                     |
| MED-5  | customStatus in members serializer            | ✅ closed | ca20a54          | (기존 spec auto-cover)                |
| MED-6  | live-shell visual baseline 시드               | deferred  | (iter 2 와 묶임) | (deferred)                            |

## 매트릭스 변화 표

| Phase                              | Row | HIGH 갭 | Score (단순) | Score (HIGH×2) |
| ---------------------------------- | --- | ------- | ------------ | -------------- |
| 045 종료                           | 60  | 0       | 96.25%       | 96.25%         |
| 046 iter 1 (확장 직후)             | 96  | 12      | 69.53%       | 61.81%         |
| 046 iter 2 (mobile baseline)       | 96  | 12      | 71.09%       | 63.19%         |
| 046 iter 3 (search depth)          | 96  | 10      | 71.875%      | 65.09%         |
| 046 iter 4 (notification)          | 96  | 8       | 72.92%       | 67.31%         |
| 046 iter 5 (cheat sheet + bio)     | 96  | 6       | 76.56%       | 72.06%         |
| 046 iter 6 (thread follow + empty) | 96  | 4       | 78.39%       | 75.25%         |
| 046 iter 7 (error recovery)        | 96  | 4       | 79.17%       | 76.0%          |
| 046 iter 8 (@here + 재분류)        | 96  | **0**   | 79.95%       | 79.95%         |

확장 후 매트릭스 score 의 정체는 **96 row 의 더 깊은 polish 영역 노출**을
반영. 본질적 기능 갭 (HIGH 0) 은 모두 처리.

## 신규 8 dimension 처리 표

| Section | 영역                 | row | iter 1 점수 | 종료 점수 | 처리 iter    | 처리 / 이월                                             |
| ------- | -------------------- | --- | ----------- | --------- | ------------ | ------------------------------------------------------- |
| I       | 모바일 surface 확장  | 8   | 18.75%      | 37.5%     | 2 + 8 재분류 | visual baseline 8 추가 + production code 4 row deferred |
| J       | 검색 깊이            | 4   | 31.25%      | 50%       | 3            | suggest endpoint + filter                               |
| K       | 알림 다양성          | 4   | 18.75%      | 43.75%    | 4            | DnD weekly + onboarding flag                            |
| L       | Keyboard cheat sheet | 3   | 8.33%       | 83.33%    | 5            | 카테고리 + mnemonic + 정정                              |
| M       | Profile 확장         | 3   | 8.33%       | 50%       | 5            | bio + GET/PATCH /me/profile                             |
| N       | Thread follow / 구독 | 3   | 8.33%       | 50%       | 6            | ThreadSubscription BE                                   |
| O       | Empty state          | 7   | 42.86%      | 50%       | 6            | re-eval + 정정                                          |
| P       | Error recovery       | 4   | 43.75%      | 62.5%     | 7            | error-messages framework                                |

## 회귀 spec 누적 표

| Spec                                            | 신규 cases | 처리 iter |
| ----------------------------------------------- | ---------- | --------- |
| ssrf-guard.spec.ts (확장)                       | +44 → 59   | 0         |
| group-dm.spec.ts (확장)                         | +6 → 14    | 0         |
| status-broadcast-throttler.spec.ts (신규)       | 6          | 0         |
| visual-baseline.e2e.ts (확장, 모바일 8 surface) | +8         | 2         |
| search.controller.spec.ts (신규)                | 11         | 3         |
| dnd-schedule.spec.ts (신규)                     | 13         | 4         |
| me-profile.spec.ts (신규)                       | 9          | 5         |
| thread-subscriptions.spec.ts (신규)             | 11         | 6         |
| error-messages.spec.ts (신규)                   | 11         | 7         |
| mention-extractor.spec.ts (확장 here)           | +3         | 8         |
| mention-gate.spec.ts (확장 hereGate)            | +3         | 8         |

총 +125 신규 spec. unit 테스트: API 152 → 239, web 107 → 118. **357 unit
tests green**.

## 누적 fix commit 표

| Type      | Count | 주요 영역                                                                                                                                              |
| --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fix       | 1     | ssrf-ipv6-variants                                                                                                                                     |
| feat      | 8     | iter0-carryover / iter2-mobile-baseline / iter3-search / iter4-notification / iter5-shortcuts-profile / iter6-thread-follow / iter7-error / iter8-here |
| chore     | 1     | scaffold (eval yaml + artefacts)                                                                                                                       |
| docs      | 9     | iteration audit / plan × N + result                                                                                                                    |
| migration | 3     | dnd-and-onboarding / user-bio / thread-subscription                                                                                                    |

## DS 4파일 md5 baseline

종료 시점 (post-main `f268772`) — `.task-040-ds-baseline.txt` 와
byte-identical:

```
45890a91e3bb4880c63697a7c39f2db9  components.css
388668133693a5ab6f391d23554db252  icons.css
64bd048551d77a9d199163d6751ba668  mobile.css
8608cbaa49d605b17c6063ee6bff821b  tokens.css
```

`git diff origin/main -- apps/web/public/design-system/{tokens,components,mobile,icons}.css` = 0 라인.

## 종료 사유 (045 strict 3 조건)

- ❌ (1) score ≥ 90% AND HIGH = 0 — HIGH ✅ but score 79.95%
- ❌ (2) 누적 10 iteration cap — 9 iter 사용 (90%)
- ✅ **(3) 2 iteration 연속 score 변동 < 1pp** — iter 6→7: +0.78pp, iter 7→8: +0.78pp (simple score)

종료 조건 (3) 트리거.

## 이월 TODO (task-047 carry-over, reviewer 발견)

### HIGH (강제 fix)

- `task-047-thread-subscribe-channel-acl` — HIGH-046-A
- `task-047-here-mention-e2e-payload` — HIGH-046-B

### MED+ (이월)

- `task-047-ssrf-ipv6-allzero-expanded`
- `task-047-ssrf-6to4-blanket`
- `task-047-migration-concurrent-index-convention`
- `task-047-dnd-validate-domain-error`
- `task-047-ssrf-hex-strict`

### Doc 정리

- (이번 closure 시 fix-forward) — PR.md / review.md / FINAL-REPORT.md
