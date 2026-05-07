# Iteration 7 — AUDIT + PLAN

## Score (시작)

- iter 6 종료 시 ≈ 93%

## 이번 iteration

**Custom status partial → full** (HIGH 갭 #7 — UI/WS 통합)

처리:

- WS 이벤트 `user.profile.updated` broadcast (BE)
- FE dispatcher 가 받아 react-query 멤버 list invalidate

UI status picker (sidebar 본인 행 클릭 → modal) 는 follow-up — 컨텍스트
budget 우선으로 BE+dispatcher 만 처리. Custom status 는 이미 PATCH +
GET /me/profile/status + 멤버 list 에 customStatus 표시됨 (서버 응답에
포함) → broadcast 가 닿으면 react-query refetch 가 자동.

## Out of scope

- UI status picker / modal: TODO(task-045-follow-status-picker)
- 10s throttle: TODO(task-045-follow-status-throttle)
- emoji prefix: TODO(task-045-follow-status-emoji)
- members list response 의 user 객체에 customStatus 포함 (이미 select 에
  포함되는지 확인 필요): TODO(task-045-follow-members-customstatus)
