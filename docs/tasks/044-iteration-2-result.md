# Iteration 2 — RESULT

## 처리 항목

**Pinned messages — BE 완성 + 최소 type plumbing** (HIGH 갭 #1)

UI 처리 (hover menu Pin/Unpin + row marker) 는 후속 처리:
`TODO(task-044-iteration-2-follow-pin-ui)`.

## Commit

| SHA     | Message                                                     |
| ------- | ----------------------------------------------------------- |
| a60ebc6 | feat(parity-pinned): pin/unpin messages BE + minimal type   |
| f65ac87 | docs(task-044): iteration 1 result + iteration 2 audit/plan |
| e3bd994 | Merge feat/task-044-dspm iter 2 → develop                   |
| f2bf9fc | Merge develop → main (auto-promote)                         |

## Verify

- `pnpm verify`: green (0 errors)
- pin.unit.spec.ts: 6/6 green (cap exceed / fresh / idempotent / soft-deleted reject / unpin / idempotent unpin)
- API total unit tests: 89 green
- Web total tests: 98 green
- DS 4 files md5 일치

## Schema migration

- `20260507000000_add_message_pin/migration.sql`: ALTER TABLE Message ADD pinnedAt TIMESTAMPTZ + pinnedBy UUID + partial index `(channelId, pinnedAt DESC) WHERE pinnedAt IS NOT NULL`
- Reversible: down via DROP COLUMN + DROP INDEX

## API

- POST `/workspaces/:id/channels/:chid/messages/:msgId/pin` — OWNER/ADMIN, cap 50, idempotent
- DELETE `/workspaces/:id/channels/:chid/messages/:msgId/pin` — OWNER/ADMIN, idempotent
- GET `/workspaces/:id/channels/:chid/messages/pins` — pinnedAt DESC, soft-deleted excluded

## WS event

- `MESSAGE_PIN_TOGGLED` — channel-scoped fanout, payload `{ workspaceId, channelId, actorId, messageId, pinnedAt|null, pinnedBy|null }`

## Deploy

- main SHA: f2bf9fc
- audit.jsonl: `deploy.result` exitCode=0
- `/api/readyz`: 200 즉시
- (idle 30s 검증은 백그라운드 진행)

## 검증 (인라인)

- DS 정합: 0 변경 (BE only)
- a11y: BE only — 영향 없음
- Contract: MessageDtoSchema, PinMessageResponseSchema, ListPinsResponseSchema, ErrorCodeSchema 'MESSAGE_PIN_CAP_EXCEEDED' 모두 정의 + Zod 호환
- Perf: pin/unpin 단건 transaction (count + update + outbox.record) — N+1 없음. listPins 는 partial 인덱스 sparse scan
- Security: OWNER/ADMIN 권한 게이트 controller 에서 enforce — 회피 경로 없음. msgId UUID validation. 메시지가 다른 채널에 있을 때 channelId 필터로 cross-channel pin 차단

## Score 변화

- 시작: 81%
- 종료: ≈ 84% (pinned BE 부분 = 0.5 가중 × HIGH 가중치 ×2 = 1.0 추가)
- 잔여 HIGH 갭: 5개 (link unfurl / mute / @everyone gate / group DM / custom status)

## HIGH 갭 처리

| #   | 항목            | 상태                       |
| --- | --------------- | -------------------------- |
| 1   | Pinned messages | 🟡 부분 (BE 완성, UI 후속) |

## Pane 1 forward

`Iter 2: parity 81%→84%, +pinned-BE (schema/API/cap50/WS), main f2bf9fc exitCode=0 readyz 200`
