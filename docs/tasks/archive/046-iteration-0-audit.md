# Iteration 0 — AUDIT (carry-over hot-fix RESULT)

## Score (시작)

- 045 종료 시 ≈ 95% (60+ row 매트릭스, HIGH=0)
- 046 시작 점에 reviewer 발견 HIGH 2 + MED 6 carry-over (별도 매트릭스
  row 로 등록 안 함 — 종료 매트릭스의 빈 자리 점수만 영향)

## 처리 항목 (BLOCKER 게이트)

| ID     | 항목                                    | 처리                                                                      | 회귀 spec                             | commit     |
| ------ | --------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ---------- |
| HIGH-1 | SSRF-IPv6 mapped/translated/NAT64       | regex 의존 제거 → group 단위 검사. dotted-quad expandIPv6 확장.           | ssrf-guard.spec.ts +44 (총 59)        | d0082eb    |
| HIGH-2 | GDM members endpoint                    | getGroupMembers + GET /me/dms/groups/:gdmId/members + 멤버 검증 leak 방지 | group-dm.spec.ts +6 (총 14)           | ca20a54    |
| MED-1  | status broadcast throttle               | StatusBroadcastThrottler (5s window, leading-block) + flush DB 재조회     | status-broadcast-throttler.spec.ts +6 | ca20a54    |
| MED-2  | mute filter tx hint                     | filterMutedRecipients default fallback 시 NestJS Logger.warn              | (동작 변경 없음, 가시성 only)         | ca20a54    |
| MED-3  | gdm SQL injection 안전 확인             | no action (reviewer 결정)                                                 | -                                     | -          |
| MED-4  | pin advisory lock 키 prefix             | no action (reviewer 결정)                                                 | -                                     | -          |
| MED-5  | customStatus in members serializer      | members.service select 절에 customStatus 추가                             | (기존 spec 자동 통과)                 | ca20a54    |
| MED-6  | live-shell visual baseline 시드 (later) | iter 2 (모바일 dimension) 와 함께 묶음 — 본 iter 에서는 spec 없음         | (deferred)                            | (deferred) |

## 회귀 spec 표

| 신규 / 확장                               | Cases | 상태 |
| ----------------------------------------- | ----- | ---- |
| ssrf-guard.spec.ts (확장)                 | +44   | ✅   |
| group-dm.spec.ts (확장)                   | +6    | ✅   |
| status-broadcast-throttler.spec.ts (신규) | +6    | ✅   |

## 측정 결과

- pnpm verify: 0 (lint 0 errors / 232 warnings legacy / typecheck OK)
- 152 → **189** unit tests green (+37)
- DS 4 파일 md5 baseline 일치 (untouched)

## 다음 단계

iter 1 — 매트릭스 확장 audit (8 dimension 추가, code 변경 0).

## Deploy plan (이번 iteration)

iter 0 는 1) HIGH/MED carry-over fix → 2) develop merge + main auto-promote.
audit-only 인 iter 1 은 deploy 없음 (다음 iter 결정).
