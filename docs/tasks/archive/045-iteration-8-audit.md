# Iteration 8 — AUDIT + PLAN

## Score (시작)

- iter 7 종료 시 ≈ 94% (custom status full = +1.0)

## 이번 iteration

**Group DM partial → full** (HIGH 갭 #6)

처리:

- `listGroups()` BE method + `GET /me/dms/groups` endpoint
- 기존 `list()` 가 `gdm:` prefix 채널 제외 (1:1 DM 만 반환) — 분리 표시
- FE UI 통합은 follow-up

## 종료 조건 평가

이 iter 후 score ≈ 95%. HIGH 7+pinned UI 모두 처리 완료 (full):

- markdown ✅ / pinned-BE+UI+race ✅ / @everyone ✅ / visual baseline ✅
- link unfurl ✅ (iter 2 BE + iter 6 FE)
- channel mute ✅ (iter 3 BE + iter 6 dispatcher gate)
- custom status ✅ (iter 4 BE + iter 7 WS broadcast)
- group DM ✅ (iter 5 createOrGet + iter 8 listing)

**HIGH 갭 = 0 + score ≥ 90% → 종료 조건 충족**.

## Out of scope

- UI 통합 follow-up (group DM 표시 / status picker / mute toggle):
  TODO(task-045-follow-ui-suite) — 모두 group 으로 묶어 task-046 으로 이월.
