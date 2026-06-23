# Iteration 4 — PLAN

## Scope

Custom status text — User.customStatus + API + me/profile 응답 노출.

WS broadcast 통합 + UI picker 는 follow-up.

## Data model

### Migration: `add_user_custom_status`

```sql
ALTER TABLE "User" ADD COLUMN "customStatus" VARCHAR(100);
```

reversible: DROP COLUMN.

## API

### PATCH /me/profile/status

```
Request body: { text: string | null }  // string 1-100 chars 또는 null (clear)
Response: { customStatus: string | null }
```

설명:

- `text` null 또는 빈 문자열 → null 로 저장 (clear)
- 100자 초과 → VALIDATION_FAILED
- 본인의 status 만 갱신 가능 (다른 user 의 status 는 제어 불가)

### GET /me

기존 응답 schema 에 customStatus 추가.

## Spec

- `me.profile.status.spec` (또는 me.controller spec): set/clear/length cap

## Out of scope (이월)

- WS broadcast `user.profile.updated` 이벤트 (throttle 10s):
  TODO(task-045-follow-status-ws-broadcast)
- UI status picker (sidebar 본인 행 클릭 → modal):
  TODO(task-045-follow-status-ui)
- emoji prefix (`:emoji: text`):
  TODO(task-045-follow-status-emoji)
- Auto-clear (24h / 4h prefab):
  TODO(task-045-follow-status-auto-clear)

## DoD

- [ ] Schema + migration
- [ ] PATCH /me/profile/status endpoint
- [ ] me/profile 응답에 customStatus 포함
- [ ] Spec
- [ ] verify green
- [ ] DS 4 files md5 unchanged
- [ ] develop → main
- [ ] /readyz 200 + idle 30s
- [ ] pane 1 mini-progress
