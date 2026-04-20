# Task 013 Review — hygiene cleanup + reactions + MinIO naming

**Reviewer**: reviewer subagent (general-purpose), model: Claude Opus 4.7 (1M context)
**Branch**: feat/task-013-hygiene-and-reactions @ b5acf7c
**Base**: develop @ fcf1bb5
**Transcript**: ~58k tokens
**Verdict**: approve-with-followups

Commit graph is clean (8 commits, conventional-commits compliant, one migration,
additive-only). `pnpm verify` green per PR.md. Spot-checked every A-chunk,
both reaction ends, and the naming hygiene greps against the actual tree — most
items hold, a handful are half-done or missed. None rise to BLOCKER. Main
gaps are (i) two acceptance-criteria test files that the task contract listed
and that never landed, (ii) task-009-low-1 (.tmp orphan trap) not actually
applied, (iii) a stale TODO reference in `runbook-local-tests.md`.

---

## Coverage of 15 priority follow-ups

| Source                                                | Resolved?         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 010-follow-3 (`/internal/metrics` allowlist)          | YES               | `services/webhook/src/server.ts:29-62` — loopback-always + bridge-peer-with-`INTERNAL_METRICS_SECRET` shared header, timing-safe compare. 403 without header.                                                                                                                                                                                                                                                 |
| 010-follow-4 (WEB_URL dev-default check)              | YES               | `apps/api/src/config/required-env.ts:22` — `DEV_WEB_URL_PATTERN` covers `127.0.0.1`, port-optional, case-insensitive; trailing slash stripped pre-match. Covered by `apps/api/test/int/config/web-url-assert.int.spec.ts:38-51`.                                                                                                                                                                              |
| 011-follow-6 (mentions cap)                           | YES               | `apps/api/src/messages/messages.service.ts:163-168` — rejects `>50` with `MESSAGE_CONTENT_INVALID` (422). **HIGH:** no integration-spec coverage for the 50-cap (see finding H1).                                                                                                                                                                                                                             |
| 011-follow-7 (MentionThrottle unit test w/ fakeClock) | **NO**            | No `mention-throttle.unit.spec.ts` anywhere in the tree; `apps/web/src/features/realtime/dispatcher.spec.ts` does not exercise `MentionThrottle.tryConsume` / `collapseOne`. Task contract AC explicitly names this file (line 158). MED finding M1.                                                                                                                                                          |
| 012-follow-3 (S3 endpoint split)                      | ALREADY-FORWARDED | `apps/api/src/storage/s3.service.ts:41-42` already uses `S3_ENDPOINT` (internal) + `S3_PUBLIC_ENDPOINT` (presign) from task-012's fix-forward commit 9c73631. No regression. Task-013 did not rename to `_INTERNAL` / `_EXTERNAL`; the semantics are equivalent. Nit only.                                                                                                                                    |
| 012-follow-9 (`test-minio` in test compose)           | YES               | `docker-compose.test.yml:30-69` — minio service + `test-minio-init` mc container; policy + user + bucket. `test-api` env at lines 99-109 points `S3_ENDPOINT` at the internal hostname and `S3_PUBLIC_ENDPOINT` at host-exposed `49000`.                                                                                                                                                                      |
| 012-follow-12 (`init-minio.sh --dry-run` without env) | YES               | `scripts/setup/init-minio.sh:33-38` — dry-run branch falls through with placeholder creds before the `:?` guards (at line 46 guards only run when `DRY_RUN=0`).                                                                                                                                                                                                                                               |
| 012-follow-13 (single ChannelAccess entry point)      | PARTIAL           | `ReactionsController` reuses `ChannelAccessByIdGuard` via `AttachmentsModule.exports` (attachments.module.ts:10-12, reactions.module.ts:9). But `ChannelAccessGuard` (route-param CanActivate) and `ChannelAccessByIdGuard` (injectable helper) both still exist as distinct classes. The contract asked for one guard; the diff did not merge them. See MED finding M2.                                      |
| 031 (invite preview + accept rate limits)             | YES               | `apps/api/src/workspaces/invites/invites.controller.ts:93-109` — preview per-IP 60/min; accept per-user 30/min + per-code 10/min. **HIGH:** task contract AC line 157 calls for `invites-rate-limit.int.spec.ts` — not present, existing `invites.int.spec.ts` untouched. Finding H1.                                                                                                                         |
| 032 (invite accept CAS error fidelity)                | YES               | `apps/api/src/workspaces/invites/invites.service.ts:167-189` — post-CAS re-read distinguishes REVOKED / EXPIRED / EXHAUSTED. New `INVITE_REVOKED` errorCode (error-code.enum.ts:25, status 410 at line 82).                                                                                                                                                                                                   |
| 033 (transferOwnership Serializable)                  | YES               | `apps/api/src/workspaces/workspaces.service.ts:177-209` — `isolationLevel: Prisma.TransactionIsolationLevel.Serializable`.                                                                                                                                                                                                                                                                                    |
| 034 (purge worker)                                    | YES               | `scripts/workers/workspace-purge.sh` with `--dry-run` branch + atomic `BEGIN; UPDATE Attachment... DELETE Workspace; COMMIT;`. Wired into `services/backup/Dockerfile` (COPY + chmod) and `entrypoint.sh` (cron line). Default `WORKSPACE_PURGE_CRON="0 5 * * *"`, after the backup cron — preserves snapshot window. `scripts/deploy/test-syntax.sh:11` adds `scripts/workers/*.sh` to the syntax lint loop. |
| 009-low-1 (.tmp trap in db/redis backup)              | **NO**            | No `trap 'rm -f "$OUT_FILE.tmp"' ERR EXIT` in either `scripts/backup/db-backup.sh` or `scripts/backup/redis-backup.sh`. The `.tmp → mv` atomic-rename pattern is still in place (db-backup.sh:36-38, redis-backup.sh:67-75) but a crash between those two lines leaks the `.tmp`. LOW finding L1.                                                                                                             |
| 009-low-2 (payload.after validated as hex SHA)        | YES               | `services/webhook/src/server.ts:213-216` — `/^[0-9a-f]{40}$/.test(payload.after)` gates the extract.                                                                                                                                                                                                                                                                                                          |
| 009-nit-1 (listener errors logged)                    | YES               | `services/webhook/src/queue.ts:84-91` — `process.stderr.write(...)` replaces the silent catch. Task contract mentioned "central logger" specifically; the webhook service has no Pino instance, and direct stderr is consistent with the existing `server.ts:106` convention. Nit only.                                                                                                                       |

Score: 12/15 landed, 2 missed (011-follow-7, 009-low-1), 1 partial (012-follow-13).

---

## Reactions (B) findings

Overall: backend is solid. Migration matches task spec 1:1. Aggregation query is
a single GROUP BY, no N+1. Outbox payload carries `channelId` at root and the
existing `@OnEvent('message.**')` handler picks it up without wiring changes.

### Verified

- Migration `apps/api/prisma/migrations/20260422000000_add_message_reactions/migration.sql` — UUID pk, cascade on Message + User, `UNIQUE (messageId, userId, emoji)`, `(messageId, emoji)` index. Matches task spec lines 59-67.
- `ReactionsService.add` `apps/api/src/reactions/reactions.service.ts:73-95` — catches `P2002` → `created=false` (idempotent, no 409). Count computed post-insert inside the same tx.
- Codepoint cap (≤4 via `[...trimmed].length`) at `reactions.service.ts:33-39`. Byte wall at `reactions.service.ts:30-32`. Match `MessageReaction.emoji` VARCHAR(64).
- `ReactionsController` `apps/api/src/reactions/reactions.controller.ts:26` uses `@UseGuards(JwtAuthGuard)`; each handler calls `this.channelAccess.requireRead(...)` (requireRead, not requireWrite — correct per task spec line 86) and `this.rateLimit.enforce([{ key: 'reactions:${user.id}', windowSec: 60, max: 60 }])`.
- Paths exactly `POST /messages/:id/reactions` (line 59) and `DELETE /messages/:id/reactions/:emoji` (line 80). ParseUUIDPipe on `:id`; emoji is decoded via `decodeURIComponent` inside the handler.
- Outbox events use `aggregateType: 'Message'` (reactions.service.ts:87, 118). Payload carries `channelId` + `workspaceId` + `userId` + `emoji` + `count`. The dispatcher's envelope-build spreads `...payloadClean` first (`common/outbox/outbox.dispatcher.ts:145-152`), so `channelId` lands at the `WsEnvelope` root. `outbox-to-ws.subscriber.ts:48-53` routes via `env.channelId` on `@OnEvent('message.**')` → works.
- `MessagesService.aggregateReactions` `apps/api/src/messages/messages.service.ts:113-136` — `$queryRaw` with `GROUP BY "messageId", emoji` and `BOOL_OR("userId" = ${viewerId}::uuid) AS "byMe"`. Single round-trip.
- Wired into `AppModule.imports` at `apps/api/src/app.module.ts:19, 41`.
- `shared-types/src/message.ts:26-31, 45, 51-54` — `ReactionSummarySchema` + `MessageDtoSchema.reactions.default([])` (forwards-compatible) + `AddReactionRequestSchema`.
- `apps/api/test/int/reactions/reactions.int.spec.ts` — covers idempotent add (lines 46-76), 204 silent no-op delete (78-101), >4 codepoint cap (103-112), non-member 403 (114-121), outbox row presence + `channelId` in payload (123-145), multi-user count aggregation (147-160).

### Findings

- **MED (M3)** — `ReactionsController.add` returns 201 on replay where the task contract line 73 said "returns 200 with the existing row". The integration spec asserts 201 on both (reactions.int.spec.ts:52, 60), so behavior is internally consistent. Decide: either relax the contract or set `res.status(200)` when `!created`. As-is the UI/dispatcher do not care, so this is cosmetic.
- **LOW (L2)** — `controller.remove` decodes URI (`decodeURIComponent`) but doesn't re-validate against the same 4-codepoint / 64-byte cap via `validateEmoji`. It delegates to `reactions.service.ts:109` which does re-validate, so behavior is correct; slight redundancy, not a bug.

---

## Reactions (C) findings

Overall: frontend wiring is tight. Dispatcher uses the shared `upsertReactionBucket`,
`byMe` preservation is explicit, `DISPATCHED_EVENTS` includes the new types so the
listener-coverage test catches drift. Optimistic hook rolls back on error.

### Verified

- `upsertReactionBucket` exported from `apps/web/src/features/realtime/dispatcher.ts:41` and unit-tested in `dispatcher.spec.ts:70-105` — empty→add, other-user add preserves my `byMe=true`, my-remove flips to `byMe=false`, count→0 drops the bucket.
- Dispatcher reaction handlers at `dispatcher.ts:303-318`; both events appear in `DISPATCHED_EVENTS` at `dispatcher.ts:458-459`.
- Listener coverage enforced by `dispatcher.spec.ts:26-36` iterating `DISPATCHED_EVENTS`.
- `useToggleReaction` `apps/web/src/features/reactions/useReactions.ts:43-53` uses `upsertReactionBucket` for the optimistic patch (same reconciler as dispatcher). Rollback via `ctx.prev` at line 57.
- `MessageList.onToggleReaction` `apps/web/src/features/messages/MessageList.tsx:93-99` guards on `m.id.startsWith('tmp-')` — optimistic rows no-op.
- E2E at `apps/web/e2e/messages/reactions.e2e.ts` — signup → workspace → post message → await `tmp-` replacement → open picker → click → pill with `aria-pressed="true"` + `aria-label` matching `👍 1` → click again → pill gone.

### Findings

- **NIT (N1)** — `ReactionBar.tsx:47` has `onClick={() => onToggle(r.emoji, r.byMe)}` but the `onToggle` arg name in `MessageItem.tsx:97` is `byMe` (matching). The name `currentlyByMe` is clearer — `MessageItem` re-shadows as `byMe` which is legible but the mutation layer at `useReactions.ts:19` is explicit `currentlyByMe`. Naming inconsistency; non-behavior.
- **NIT (N2)** — The E2E is single-context (one browser page). Task contract line 108-111 called for a 2-context scenario (A reacts → B sees within 2s) and a 70-in-60s rate-limit verification. Neither landed. The single-context happy path is what GHA will run; the multi-context / rate-limit coverage moves to follow-up. Defer.

---

## Naming hygiene (D) findings

Overall: greps pass. Framing line landed. No AWS cloud-target drift.

### Verified

- `grep -rn '"S3 storage"\|"in S3"\|"S3 prod"\|"S3 bucket"\|"AWS S3"' apps/ services/ docs/ scripts/` → 4 hits, all inside `docs/tasks/013-hygiene-and-reactions.md` (lines 119, 120, 167, 265-266) and `docs/tasks/013-hygiene-and-reactions.PR.md` (line 27). Both are task-013's own meta-references, acceptance-compliant per the contract's "task-013 doc aside" carve-out.
- `grep -E 'AWS|Terraform|Helm|kubernetes|CloudWatch|Sentry|External Secrets|S3 prod' CLAUDE.md` → 0 lines.
- `docs/ops/runbook-local-tests.md:3-7` has the framing line at the top: "Object storage in this project is a MinIO container running on the NAS... the API talks to it via the AWS S3 SDK because MinIO speaks the S3 wire protocol."
- S3-layer references in `apps/api/src/storage/s3.service.ts` (S3Service, S3Client, env names, JSDoc) are all protocol-terms — correct per memory feedback_minio_naming.md.

### Findings

- **NIT (N3)** — `docs/ops/runbook-local-tests.md:89-96` still says MinIO is "tracked as `TODO(task-012-follow-test-minio)`" and "Running the rest of the e2e suite is fine" under an "Attachment E2E on the NAS" section. Since task-013 actually added `test-minio` + `test-minio-init` to `docker-compose.test.yml`, this paragraph is stale — the local runs now work too. The TODO reference lives in `.md` so the acceptance grep (ts/tsx/sh) doesn't catch it. Doc-freshness nit; defer as `TODO(task-013-follow-1)`.

---

## Cross-cutting

- **Migration**: additive only (new table + indexes). No `DROP` / `TRUNCATE` / backfill. Cascade on Message + User. Verified via `grep` on migration.sql. Rollback = `DROP TABLE "MessageReaction"`.
- **Conventional commits**: all 8 commit subjects follow `type(scope): subject`. Task tags (`task-013-B`, `task-031`, `task-033` etc.) embedded cleanly.
- **No destructive ops**: no migrations touch existing rows, no data backfill scripts with unbounded scope, no `rm -rf` in the new worker.
- **`any`-type hygiene**: diff grep `^\+.*:\s*any\b` returns 0 new additions. Callsite types are explicit (e.g., `MessageRow`, `ReactionSummary`).
- **`console.log` in prod paths**: diff grep `^\+.*console\.log` returns 0. Webhook queue listener-error path uses `process.stderr.write` (queue.ts:88), consistent with `server.ts:106`.
- **Secrets**: `docker-compose.test.yml` inlines a hardcoded test-only `testminio-password-change` + `qufox-api-test-secret-40-chars`. These are test-stack-only credentials that never touch prod; no real secrets committed.
- **Nest module hygiene**: `ReactionsModule` imports `AuthModule`, `AttachmentsModule`, `OutboxModule` — pulls `ChannelAccessByIdGuard` + `RateLimitService` + `OutboxService` + `PrismaService` cleanly. No provider/dependency leaks.
- **Shared-types back-compat**: `MessageDtoSchema.reactions.default([])` (message.ts:45) means older API builds that don't send `reactions` still parse. Forward-compatible.

No BLOCKER or HIGH-sec findings. No regressions detected in the pass-forward
chain (outbox dispatch, WS envelope building, guard chain).

---

## Deferred to task-013-follow-\*

- **TODO(task-013-follow-1)**: refresh `docs/ops/runbook-local-tests.md` "Attachment E2E on the NAS" section — `test-minio` is now in the test compose (task-013-A4), the stale `TODO(task-012-follow-test-minio)` paragraph at lines 89-96 is no longer true.
- **TODO(task-013-follow-2)** (H1): add `apps/api/test/int/workspaces/invites-rate-limit.int.spec.ts` — exercise the per-user 30/min, per-code 10/min, per-IP preview 60/min caps (429 on overage, `NODE_ENV=test` cap-bump noted); add `INVITE_REVOKED` error-fidelity case covering the post-CAS re-read (revoke between findUnique and CAS).
- **TODO(task-013-follow-3)** (M1): add `apps/web/src/features/realtime/mention-throttle.unit.spec.ts` (or an embedded `describe` in `dispatcher.spec.ts`) with `vi.useFakeTimers` + `vi.advanceTimersByTime` to verify `MentionThrottle.tryConsume`'s 5-token bucket + 5/s refill and the 1-second `collapseOne` rollup. Task-011-follow-7 closure.
- **TODO(task-013-follow-4)** (M2): consolidate `ChannelAccessGuard` + `ChannelAccessByIdGuard` into a single entry point (either promote `ChannelAccessByIdGuard` to a CanActivate-capable adapter, or move the Permission-bit check into a shared service both guards call). Task-012-follow-13 remains partially open.
- **TODO(task-013-follow-5)** (M3): decide 200-vs-201 on reaction POST replay. Either document 201-on-replay as intentional (natural unique-row idempotency, client doesn't care) and amend the task contract, or set `res.status(200)` when `!created` to match the original contract.
- **TODO(task-013-follow-6)** (L1): add `trap 'rm -f "$OUT_FILE.tmp"' EXIT` to `scripts/backup/db-backup.sh` and `scripts/backup/redis-backup.sh` to clean up `.tmp` leaks from a crash between `pg_dump --file "$OUT_FILE.tmp"` and `mv "$OUT_FILE.tmp" "$OUT_FILE"`. Task-009-low-1 closure.
- **TODO(task-013-follow-7)** (N2): extend `apps/web/e2e/messages/reactions.e2e.ts` to multi-context (two browser contexts, A reacts → B sees within 2s) + a rate-limit assertion (70 clicks in 60s → 10 drops with `NODE_ENV=test` cap-bump). Current happy-path smoke is sufficient for MVP.
- **TODO(task-013-follow-8)** (N3): rename `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` to `S3_ENDPOINT_INTERNAL` / `S3_ENDPOINT_EXTERNAL` per the task-012-follow-3 original proposal if naming precision matters; current behavior is correct. Low value, cosmetic.
