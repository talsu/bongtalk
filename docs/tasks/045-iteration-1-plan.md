# Iteration 1 — PLAN

## Scope

(A) H1 pin-cap-race fix + (B) Pinned UI affordance 본격 도입.

## (A) H1 pin-cap-race fix

### 전략

PostgreSQL `pg_advisory_xact_lock(key)` 를 pin tx 시작 시 호출해 채널 단위 직렬화. transaction commit/rollback 시 자동 해제 → 별도 cleanup 불필요.

```sql
SELECT pg_advisory_xact_lock(hashtextextended('pin:' || $channelId, 0))
```

`hashtextextended(text, bigint)` → bigint 반환 (PostgreSQL 12+ 가용). channelId UUID 를 텍스트로 변환 후 prefix `pin:` 추가하면 다른 advisory lock domain 과 충돌 X.

### 변경 위치

- `apps/api/src/messages/messages.service.ts` `pin()` 의 transaction 시작에 `await tx.$queryRaw\`SELECT pg_advisory_xact_lock(...)\``
- 같은 직렬화 보장으로 `unpin()` 은 적용 X (cap 영향 없음)

### Spec 추가

- `apps/api/test/unit/messages/pin-race.unit.spec.ts`: vi.fn() 으로 advisory lock query 호출 여부 검증 + count → update 순서 검증
- 본격 race 검증은 testcontainers 가 필요해 별도 follow-up

## (B) Pinned UI affordance

### 변경 사항

#### 1. MessageItem dropdown menu (OWNER/ADMIN 만)

- 현재 dropdown 에 `Pin` / `Unpin` 항목 추가
- 핀 상태 (`message.pinnedAt !== null`) 로 텍스트 토글
- 클릭 → API 호출 (`pinMessage` / `unpinMessage`)

#### 2. 메시지 행 pin marker

- `pinnedAt !== null` 시 메시지 헤더 (author + timestamp) 옆에 작은 pin 아이콘
- DS `qf-i-pin` icon (이미 등록) + `text-text-secondary text-xs` Tailwind

#### 3. API 클라이언트 함수

- `apps/web/src/features/messages/api.ts` (또는 messages-api.ts) 에 `pinMessage(wsId, channelId, msgId)` + `unpinMessage(...)` 추가
- POST `/workspaces/:wsId/channels/:chid/messages/:msgId/pin`
- DELETE 동일 경로

#### 4. WS dispatcher MESSAGE_PIN_TOGGLED 핸들러

- `apps/web/src/features/realtime/dispatcher.ts` 가 `message.pin.toggled` 이벤트 수신 시 react-query cache 의 해당 메시지 row 의 `pinnedAt` / `pinnedBy` 갱신
- DISPATCHED_EVENTS 에 추가

### Spec 추가

- `apps/web/src/features/messages/MessageItem.spec.tsx` (or new): pin/unpin dropdown rendering, click handler call
- 또는 e2e (시간 budget 따라 결정)

## DoD

- [ ] H1 race fix: advisory lock query in pin tx + spec
- [ ] MessageItem dropdown Pin/Unpin (OWNER/ADMIN gate)
- [ ] Row pin marker (pinnedAt !== null)
- [ ] API client functions
- [ ] WS dispatcher MESSAGE_PIN_TOGGLED 핸들러
- [ ] `pnpm verify` green
- [ ] DS 4파일 md5 unchanged
- [ ] visual regression baseline 보존 (UI 변경이 DS mockup 에 영향 X)
- [ ] develop merge → main auto-promote
- [ ] /readyz 200 + idle 30s
- [ ] pane 1 mini-progress

## Out of scope (이월)

- Pinned panel drawer (channel header Pin button → side panel): `TODO(task-045-follow-pin-panel)`
- 모바일 long-press Pin menu: `TODO(task-045-follow-mobile-pin)`
- Pin permission per-channel override: `TODO(task-045-follow-channel-pin-perm)`
- Pin idempotency-key header (044 M1 reviewer): `TODO(task-045-follow-pin-idempotency)`
- testcontainers race integration spec: `TODO(task-045-follow-pin-race-int-spec)`
