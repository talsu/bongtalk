# Iteration 2 — PLAN

## Scope

**Pinned messages** — schema + API + 최소 UI affordance (hover menu Pin/Unpin + 메시지 행 pin 마커).

> Note: 본격적인 "Pinned panel" (채널 헤더 pin 버튼 → 드로어 with 모든 핀) 는 별도 후속 처리 (`TODO(task-044-iteration-2-follow-pin-panel)`). 본 iteration 은 BE 완성 + 최소 surface 만.

## Data model

### Migration: `add_message_pin`

```prisma
model Message {
  // ... 기존 필드
  pinnedAt  DateTime? @db.Timestamptz
  pinnedBy  String?   @db.Uuid
  // 채널 별 pinned 조회 인덱스 (partial)
  @@index([channelId, pinnedAt])
}
```

- Reversible: down → drop 컬럼 + 인덱스
- 데이터 백필 불필요 (NULL → 미고정)

### Cap

- 채널 당 최대 50 pin (Discord 동일). 초과 시 `MESSAGE_PIN_CAP_EXCEEDED` ErrorCode 반환.

## API

### Permission

- 워크스페이스 OWNER 또는 ADMIN 만 pin/unpin 가능 (MEMBER 는 401)
- 메시지 자체 author 도 OK? — 현재는 OWNER/ADMIN 만 (Discord 의 manage_messages 등가)

### Endpoints

```
POST   /workspaces/:wsId/channels/:chid/messages/:id/pin
DELETE /workspaces/:wsId/channels/:chid/messages/:id/pin
GET    /workspaces/:wsId/channels/:chid/pins
```

#### Request / Response

- POST/DELETE pin: body 없음, 200 + `{ id, pinnedAt, pinnedBy }`
- GET pins: 200 + `{ items: [{ id, content, contentPlain, authorId, createdAt, pinnedAt, pinnedBy }], cap: 50, used: N }`
  - 정렬: `pinnedAt DESC`
  - reactions / threadSummaries / attachments aggregation 은 phase 1 에서 skip (panel UI 도 phase 2)

### WS event

- `MESSAGE_PIN_TOGGLED` payload: `{ channelId, messageId, pinnedAt: ISO|null, pinnedBy: uuid|null }`
- 채널 룸 fanout, outbox 패턴 유지

## UI

### MessageItem hover menu

- 기존 dropdown 에 Pin/Unpin 항목 추가 (OWNER/ADMIN 만 visible)
- 토글: 핀 상태 → "Unpin", 미핀 상태 → "Pin"
- Pin 후 메시지 행 좌측에 작은 📌 아이콘 (Tailwind utility `text-text-secondary text-xs`)

### MessageList row decoration

- `MessageDto` 에 `pinnedAt` 추가 → row 가 핀 시 small pin marker 노출

### Pinned panel (phase 2 — 후속)

- 채널 헤더 우측에 Pin 아이콘 버튼
- 클릭 → 우측 드로어 (`qf-drawer` DS 컴포넌트 가정 — 없으면 page-scoped div)

## Spec

### Unit (Vitest, apps/api)

- `messages.service.spec`: pin / unpin / cap exceed / repeat-pin idempotent

### Integration (Jest + Testcontainers, apps/api)

- POST /pin OWNER → 200, 행 pinnedAt 갱신
- POST /pin MEMBER → 403
- POST /pin (51번째) → MESSAGE_PIN_CAP_EXCEEDED 409
- DELETE /pin OWNER → 200, pinnedAt = NULL
- GET /pins → 정렬 DESC

### E2E (Playwright, apps/web)

- `apps/web/e2e/messages/pin.e2e.ts`: 메시지 hover → Pin 클릭 → marker 노출 확인

## DoD (iteration 2)

- [ ] Prisma migration 적용 + reversible
- [ ] API endpoints 3개 + Zod schema (pin/unpin response, list pins response)
- [ ] OWNER/ADMIN permission gate
- [ ] cap 50 enforcement
- [ ] WS event emitted
- [ ] UI: hover menu Pin/Unpin + row marker
- [ ] Spec: int 4 + e2e 1
- [ ] DS 4파일 md5 unchanged
- [ ] `pnpm verify` green
- [ ] develop merge → main auto-promote
- [ ] /readyz 200 + idle 30s
- [ ] pane 1 mini-progress 1줄 forward

## Out of scope (이월)

- Pinned panel UI (channel header button → drawer): `TODO(task-044-iteration-2-follow-pin-panel)`
- Per-channel pin permission override: `TODO(task-044-follow-channel-pin-perm)`
- 모바일 long-press menu Pin/Unpin: `TODO(task-044-iteration-2-follow-mobile-pin)`
