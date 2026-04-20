# Task 013 PR — Hygiene cleanup + Message Reactions + MinIO naming

**Branch:** `feat/task-013-hygiene-and-reactions`
**Base:** `develop` (`fcf1bb5`)
**Merge style:** direct `git merge --no-ff` to develop (no GitHub PR per 011/012 convention)
**Memory touched:** references `feedback_minio_naming.md` (created 2026-04-20)

## Summary

- **A** (4 commits) — 15 priority follow-ups across 009/010/011/012 resolved:
  - Invite accept/lookup got per-code + per-user rate limits (`31` HIGH-sec); CAS-0-rows path distinguishes `NOT_FOUND` / `EXPIRED` / `EXHAUSTED` / `INVITE_REVOKED` (`32` UX) — new `INVITE_REVOKED` errorCode.
  - `transferOwnership` bumped to `Serializable` (`33` MED); nightly workspace-purge worker (`34` MED) runs at 05:00 against rows past the 30-day grace window, marking stranded attachments as orphan for the existing attachment-orphan-gc cron to sweep.
  - `/internal/metrics` is now split into loopback-always-allowed + bridge-peer-with-shared-secret-header; `WEB_URL` dev-default guard covers `127.0.0.1`, trailing slash, case; mention fan-out capped at 50 users per message; webhook `payload.after` validated as SHA-1; listener errors go through stderr instead of silent swallow.
  - Test stack gains `test-minio` + `mc` init container so `pnpm --filter @qufox/api test:int` runs on this NAS without manual MinIO bootstrap.
- **B** — Message Reactions API:
  - `MessageReaction` table with `(messageId, userId, emoji)` unique index → natural idempotency (repeat POST returns the existing row, no 409).
  - `POST /messages/:id/reactions` + `DELETE /messages/:id/reactions/:emoji` under `ReactionsController`, gated by `JwtAuthGuard` + `ChannelAccessByIdGuard.requireRead` + 60/60s rate limit per user.
  - Codepoint cap (≤4 via `[...trimmed].length`) + 64-byte wall matches DB VARCHAR.
  - `MessageDto` grows `reactions: [{ emoji, count, byMe }]`; aggregated in a single GROUP BY with `BOOL_OR("userId" = :viewer)` — no N+1.
  - Outbox events `message.reaction.added` / `.removed` carry `channelId` so the existing `@OnEvent('message.**')` subscriber routes to the channel room unchanged.
- **C** — Reactions frontend:
  - `ReactionBar` renders pills + an 8-emoji quick-picker under each message. Self-reacted pills highlight via accent color. Optimistic toggle ±1 is overwritten by the server's authoritative count when the WS echo arrives.
  - `upsertReactionBucket` is the single reconciler, shared between the mutation hook and the dispatcher — unit-tested for byMe-preservation when someone else reacts.
  - E2E `reactions.e2e.ts` drives the happy path (open picker → pick 👍 → pill appears with aria-pressed=true → click pill → pill disappears).
- **D** — MinIO/S3 naming hygiene:
  - `runbook-local-tests.md` gets an explicit one-line framing: "MinIO on the NAS, API talks via AWS S3 SDK because MinIO speaks S3 wire protocol." `S3Service` / `S3_ENDPOINT` in the body now read unambiguously.
  - Acceptance greps confirmed 0 lines for `"AWS S3"` / `"S3 storage"` / `"S3 prod"` etc. in `apps/ services/ docs/ scripts/` (task-013 doc and task-012 archive aside, those are meta-references).
  - CLAUDE.md regression guard (`AWS|Terraform|Helm|kubernetes|CloudWatch|Sentry|External Secrets|S3 prod`) → 0 lines, carried forward from task-012-H.

## Verify

```
pnpm verify → green
```

Tasks: 19 successful, 19 total. Warnings only (pre-existing unused-args noise).

Specifically:

- `@qufox/api:typecheck` ✓
- `@qufox/shared-types:test` ✓ (8 tests)
- `@qufox/api:test` ✓ (59 tests)
- `@qufox/web:test` ✓ (6 tests incl. new `upsertReactionBucket` + dispatcher reaction branch)
- `@qufox/web:typecheck` ✓

## Test plan

- [x] `pnpm --filter @qufox/api test` (unit)
- [x] `pnpm --filter @qufox/shared-types test`
- [x] `pnpm --filter @qufox/web test`
- [ ] `pnpm --filter @qufox/api test:int` (GHA integration workflow exercises the new `reactions.int.spec.ts`)
- [ ] `pnpm --filter @qufox/web test:e2e` (GHA e2e workflow exercises `reactions.e2e.ts`)

## Commits

```
b5acf7c docs(naming): task-013-D — MinIO framing line in runbook-local-tests
236951b feat(reactions): task-013-C — ReactionBar + optimistic toggle + dispatcher routes
94449ab feat(reactions): task-013-B — MessageReaction table + POST/DELETE + outbox + DTO join
2a70b3b feat(test-compose): task-013-A4 — test-minio + init container for attachments int/e2e
6aa10f9 fix(security): task-013-A3 — metrics allowlist + WEB_URL + mentions cap + payload SHA + listener log
7264ac5 fix(workspaces): task-013-A2 — task-033 Serializable + task-034 purge worker
70fac9a fix(invites): task-013-A1 — task-031 per-code rate limit + task-032 CAS error fidelity
aaedef2 docs(task-013): hygiene cleanup + reactions task contract
```

## Migration

`apps/api/prisma/migrations/20260422000000_add_message_reactions/` — additive
only (new table + indexes, no backfill, no existing-row mutation). Rollback =
`DROP TABLE "MessageReaction"` (indexes cascade).
