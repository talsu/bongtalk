# Task 013 — Hygiene Cleanup (~15 follow-ups) + Message Reactions

## Context

Tasks 009/010/011/012 reviewer subagents fixed BLOCKER + HIGH findings
forward but deferred MED/LOW/NIT items as `TODO(task-NNN-follow-*)`
markers. Cumulative count after task-012 merge: 34 deferred items
across 5 task generations. Adding more big features without a sweep
risks a regression net frayed by year-old debt.

Task 013 picks the ~15 highest-priority follow-ups (security, DoS,
operational correctness) and resolves them, then ships Reactions —
a small feature that lays naturally on top of the message system
without a model change. Threads (TODO(task-024)) and FTS
(TODO(task-025)) are bigger and stay deferred.

Naming hygiene also lands here. After task-012 merged, the user
paused to ask "왜 S3가 계속 언급 되는거야?" because design docs and
runbooks used "S3" as a deployment noun for what is in fact a MinIO
container on the NAS. The new memory `feedback_minio_naming.md`
documents the convention; this task applies it across the repo.

## Scope (IN)

### A. Follow-up cleanup (priority candidates)

UNDERSTAND step verifies which TODO markers are still live in code
(some may have been fix-forward'd in later commits). Live ones are
resolved; already-fixed ones get their review.md status table
updated and TODO marker removed from the doc.

| Source        | Item                                                                                                                                                 | Priority           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 010-follow-3  | `/internal/metrics` allowlist tightened — switch to shared-secret header or restrict to docker bridge subnet                                         | HIGH (security)    |
| 010-follow-4  | `WEB_URL` dev-default check covers `127.0.0.1`, trailing slash, `LOCALHOST` (case-insensitive)                                                       | HIGH (ops)         |
| 011-follow-6  | `mentions.users.length` cap (50) — reject create with 400 if exceeded                                                                                | HIGH (DoS)         |
| 011-follow-7  | `MentionThrottle` unit test using injected `fakeClock` (matches 005 pattern)                                                                         | MED                |
| 012-follow-3  | `S3_ENDPOINT` split into `S3_ENDPOINT_INTERNAL` (api → minio in-network) and `S3_ENDPOINT_EXTERNAL` (presign URL host); presign always uses external | HIGH (correctness) |
| 012-follow-9  | `test-minio` service added to dev compose profile so `pnpm test:int` can hit MinIO locally without manual setup                                      | MED (DX)           |
| 012-follow-12 | `init-minio.sh --dry-run` works without env vars set (prints what would be done)                                                                     | LOW                |
| 012-follow-13 | `ChannelAccessGuard` reroute — single entry point, attachment + reaction + message all use the same guard                                            | MED (structure)    |
| 031           | rate-limit `GET /invites/:code` (per IP 60/min) and `POST /invites/:code/accept` (per code 10/min)                                                   | HIGH (security)    |
| 032           | invite accept CAS-0-rows error fidelity — distinguish `INVITE_NOT_FOUND` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` / `INVITE_REVOKED`                  | MED (UX)           |
| 033           | `transferOwnership` `$transaction` bumped to `isolationLevel: 'Serializable'`                                                                        | MED (consistency)  |
| 034           | soft-delete purge worker — cron container hard-deletes Workspace rows where `deleteAt < now() - 30 days`                                             | MED (ops)          |
| 009-low-1     | `.tmp` orphan trap — `trap 'rm -f "$OUT_FILE.tmp"' ERR EXIT` in db-backup.sh / redis-backup.sh                                                       | LOW                |
| 009-low-2     | `payload.after` validated as a hex SHA in webhook handler                                                                                            | MED (security)     |
| 009-nit-1     | listener errors in `services/webhook/src/queue.ts:58-64` logged via the central logger instead of being silently swallowed                           | LOW                |

Processing rule: each item that's still live becomes a one-line fix
plus its TODO marker removal. Items already fix-forward'd: only the
review.md status row updates. The 015 fix-forward gap (031
specifically) gets its own commit because it touches middleware +
spec.

### B. Reactions backend (closes TODO(task-023))

- Prisma `MessageReaction` table:
  ```
  id        uuid pk
  messageId uuid fk -> Message.id ON DELETE CASCADE
  userId    uuid fk -> User.id ON DELETE CASCADE
  emoji     varchar(64)        -- unicode string (👍, ❤️, ZWJ-joined)
  createdAt timestamptz default now()
  unique (messageId, userId, emoji)
  ```
  Index: `(messageId, emoji)` for the per-message GROUP BY count.
- API endpoints (under `/messages`):
  - `POST /messages/:id/reactions` — body `{ emoji }`. Validates
    channel READ permission via `ChannelAccessGuard`. Validates
    `[...emoji].length <= 4` (codepoint-aware, allows ZWJ
    sequences). Idempotent: repeating the same `(msg, user,
emoji)` returns 200 with the existing row (no error).
  - `DELETE /messages/:id/reactions/:emoji` — removes only the
    caller's own row.
  - Existing `GET /channels/:chid/messages` DTO grows
    `reactions: { emoji, count, byMe }[]`. Added via a single
    GROUP BY join — no N+1.
- Outbox events emitted from the same DB transaction as the
  reaction write:
  - `message.reaction.added { messageId, channelId, userId, emoji, count }`
  - `message.reaction.removed { messageId, channelId, userId, emoji, count }`
- Rate limit: 60 reactions / minute per user (sliding window via
  Redis, reuses the 005 pattern). Excess returns 429; metric
  `qufox_rate_limit_dropped_total{endpoint="reactions"}`.
- ACL: channel READ is sufficient. WRITE_MESSAGE is not required —
  reacting is a lighter interaction than posting.

### C. Reactions frontend

- `MessageItem` gets a reaction bar below the message body:
  - Active reactions render as `[👍 3] [❤️ 1] [+]`.
  - The `[+]` opens an emoji picker (`emoji-picker-element`,
    ~30 KB, lazy-loaded).
  - Self-added emoji are highlighted (background + ring).
  - Click on an existing reaction toggles add/remove.
  - Hover on a reaction shows reactor name list (lazy
    `useUsers(...)` batch query, only fires on hover).
- Realtime dispatcher branch in `features/realtime/dispatcher.ts`:
  - `message.reaction.added` → patch the message in cache,
    bumping the `reactions` array entry or inserting a new one,
    `byMe = (event.userId === viewer.id)`.
  - `message.reaction.removed` → reverse.
- Optimistic update: clicking add/remove immediately updates the
  cache; on API failure, rollback + toast `"Reaction failed"`.
- E2E `apps/web/e2e/reactions.e2e.ts`:
  - 2 contexts. A reacts → B sees the count bump within 2s.
  - A clicks again → count drops on both sides.
  - A reacts to 70 messages in 60s → 429 fired, 60 of them
    succeed (rate limit verification — relax test envvar to
    keep the test fast).

### D. Naming + grep hygiene

- Run `grep -rn 'S3' apps/ services/ docs/ scripts/ --include='*.md' --include='*.sh' --include='*.ts'` and classify each hit:
  - **Keep:** code-layer references (`S3Service`, `S3_ENDPOINT`,
    `@aws-sdk/client-s3`, `presigned-S3-URL`, env var names,
    library names). These describe the wire protocol.
  - **Rewrite:** deployment nouns ("S3 storage", "stored in S3",
    "S3 backup", "S3 prod") → "MinIO", "object storage on the
    NAS".
  - **Add framing:** runbooks / docs that mention storage at all
    get a one-time framing line on first mention: "Object storage
    is MinIO running on the NAS at `/volume3/qufox-data/minio/`;
    the API talks to it via the AWS S3 SDK because MinIO is
    S3-compatible."
- CLAUDE.md regression guard: `grep -E 'AWS|Terraform|Helm|kubernetes|CloudWatch|Sentry|External Secrets|S3 prod' CLAUDE.md` returns **0 lines**. (Task-012-H should have done this; reverify.)
- `docs/ops/*.md` same grep returns **0 lines**.
- The new memory `feedback_minio_naming.md` is referenced from the
  013 PR.md so future implementers reading the change log find it.

## Scope (OUT) — future tasks

- Threads — TODO(task-024). Big: parent_id column, threaded UI.
- FTS — TODO(task-025). Postgres full-text or external engine.
- Custom emoji upload (image-backed) — separate task.
- Reaction permission masks (role-restricted reacts) — overkill.
- Reaction notifications (mentions-style) — beta out.
- Beta operations support (admin onboarding, whitelist, feedback) — separate task.
- PITR / WAL archiving — separate ops task.
- sops / age secret encryption — separate ops task.
- Loki self-hosted — TODO(task-019).
- 009 LOW/NIT residue (4 items: NIT-2/-3/-4, low-3) — defer.
- 010 follow-1, -2, -5 — UX micros, defer.
- 011 follow-8, -9 — test/doc nits, defer.
- 012 follow-2, -4, -5, -6, -7, -8, -10, -11 — already fix-forward'd
  in 012 commits or low-priority, defer.

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to `docs/tasks/013-*.PR.md`.
- `pnpm --filter @qufox/api test:int` green on GitHub Actions.
  New specs:
  - `reactions.int.spec.ts` (add / remove / idempotency / cap /
    rate limit / ACL)
  - `invites-rate-limit.int.spec.ts` (031 fix verification)
  - `mention-throttle.unit.spec.ts` (011-follow-7 closure;
    unit, runs in `pnpm test`)
- `pnpm --filter @qufox/web test:e2e` green on GitHub Actions:
  - `reactions.e2e.ts` newly added.
- One Prisma migration, **reversible-first** (down asserted by
  db-migrator subagent):
  - `add_message_reactions.sql` + down.
- TODO regression guard:
  - `grep -rn 'TODO(task-009-low-1\|TODO(task-009-low-2\|TODO(task-009-nit-1\|TODO(task-010-follow-3\|TODO(task-010-follow-4\|TODO(task-011-follow-6\|TODO(task-011-follow-7\|TODO(task-012-follow-3\|TODO(task-012-follow-9\|TODO(task-012-follow-12\|TODO(task-012-follow-13\|TODO(task-031\|TODO(task-032\|TODO(task-033\|TODO(task-034' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**. Historical reference in `docs/tasks/*.review.md` is allowed.
- Naming hygiene grep:
  - `grep -rn '"S3 storage"\|"in S3"\|"S3 prod"\|"S3 bucket"\|"AWS S3"' apps/ services/ docs/ scripts/` returns **0 lines**.
  - `grep -E 'AWS|Terraform|Helm|kubernetes|CloudWatch|Sentry|External Secrets|S3 prod' CLAUDE.md` returns **0 lines**.
- 3 artefacts: `013-*.md`, `013-*.PR.md`, `013-*.review.md`.
- 1 eval added: `evals/tasks/028-message-reactions.yaml`.
- Reviewer subagent **actually spawned**; transcript token count
  recorded in `013-*.review.md` header.
- **Direct merge to develop** (PR creation skipped). Commit
  message: `Merge task-013: hygiene cleanup + reactions + MinIO naming`.

## Prerequisite outcomes

- 012 merged to develop (`fcf1bb5`).
- GHA `integration` + `e2e` workflows from 011-D running and
  green on the 013 branch before merge.
- `feedback_minio_naming.md` registered in MEMORY.md (done by
  pane 1 before this task hands off).

## Design Decisions

### Reactions store unicode strings, not codepoint mapping

Save `varchar(64)` of the literal emoji as typed/picked. Reasons:

- Adding new emojis requires no backend code change.
- Search and rendering are trivial (DB → JSON → renders as-is).
- 64 chars accommodates ZWJ sequences (👨‍👩‍👧‍👦 etc.) up to
  ~20 codepoints.
- Codepoint-count cap (≤4) is enforced via `[...str].length` so
  malformed flags / national flags / family emoji all fit.

### Rate limit at 60 reactions/minute

Reuses the 005 sliding-window pattern. The cap is generous enough
that humans never hit it but a click-spam script does. Excess returns
429 silently in the UI (no toast — toast on rate limit is more
annoying than helpful for a low-stakes interaction). The drop is
visible in `qufox_rate_limit_dropped_total{endpoint="reactions"}`.

### Reactor list is lazy

Hover shows the reactor names. Without hover the list never
queries. Batching uses the existing `useUsers([...ids])` hook from
008 — same pattern as @mention rendering. 100 reactors → one
batched user query.

### Don't bundle follow-up fixes into one commit

Each follow-up is a one-line fix, but bundling 12 of them into one
commit makes the diff hard to review and harder to revert
individually. Use 1 commit per source-task family — e.g.
`fix(task-010-follow): /internal/metrics + WEB_URL hardening`,
`fix(task-031): invite endpoint rate limit`, etc. The 031 commit
is its own because it touches middleware + a new spec.

### Reactions WS event is a new outbox type

`message.reaction.added` and `message.reaction.removed` are new
outbox event types. The 005 dispatcher already routes by type —
no infrastructure change. Adding type entries in
`outbox.types.ts` plus the dispatcher branches is mechanical.

### Naming hygiene scope is grep-driven

Don't try to enumerate every file ahead of time. Run the grep,
classify each hit, fix or annotate. The acceptance criteria test
is the same grep — finishes when zero lines.

## Non-goals

- Custom emoji (image upload, attachment-style) — separate task,
  needs MinIO + thumbnail story.
- Per-channel emoji packs — Discord-style server emojis. Out.
- Reaction-to-mention bridge ("they reacted with 👀 to your @"
  notification) — out.
- Reaction count badge in sidebar (matching unread/mention dots) —
  noisy, out.
- Bulk follow-up cleanup of 010 follow-1/2/5 et al. (UX micros) —
  defer to a future hygiene pass.

## Risks

- **Live-vs-stale TODO check is the first concrete step.** If the
  list grep at UNDERSTAND turns up many already-fixed items, the
  scope shrinks (good). If it turns up extra TODO families this
  doc didn't account for, surface to user before adding scope.
- **Migration is additive (new table) so no message-table lock.**
  No risk surface.
- **Optimistic update on reaction failure** — the rollback case
  needs explicit testing because users will spam-click. E2E
  includes a 401-injected branch.
- **Rate-limit interplay with 002 invite tests** — 031 adds rate
  limits on `/invites`, and 002 integration tests fire many calls
  in parallel from the same IP. Mitigation: reuse the existing
  `NODE_ENV=test` envvar pattern that bumps caps 100x; the same
  trick 005 uses. Verify before commit.
- **Naming grep produces false positives** — "S3" appears in any
  line that uses the SDK / env name. The classification step is
  manual review per-file, not blanket sed. The acceptance grep is
  scoped to deployment-noun phrasings (`"S3 storage"`,
  `"in S3"`), not bare `S3`.
- **`MentionThrottle` test still flaky** — the unit test for
  011-follow-7 needs deterministic time. Use the same
  `fakeClock` helper 005 introduced; if 005's helper is
  unsuitable for mention throttle's use site, add a small
  per-throttle clock injection rather than rewriting 005.
- **`init-minio.sh --dry-run` without env (012-follow-12)** — the
  script today panics on missing env vars even before --dry-run
  branch. Wrap the env-derived bits behind a guard or move the
  `--dry-run` short-circuit to the very top.
- **CLAUDE.md grep accidentally hits a memory reference** — the
  grep is scoped to CLAUDE.md and `docs/ops/*.md`. Memory files
  under `~/.claude/projects/.../memory/` are excluded by path.
- **Reviewer pushback on emoji 64-char cap** — some platforms
  permit longer ZWJ chains. If reviewer raises this, raise to
  128 in the migration's down-script-tested up.

## Progress Log

_Implementer fills this section. Four commit groups:
A (cleanup), B (reactions backend), C (reactions frontend),
D (naming hygiene). The order doesn't matter for correctness;
running A first means the test environment is cleaner for
B/C testing._

- [ ] UNDERSTAND (TODO grep — confirm which follow-ups are live)
- [ ] PLAN approved
- [ ] SCAFFOLD (reactions migration red, reactions service stub)
- [ ] IMPLEMENT (A → B → C → D)
- [ ] VERIFY (`pnpm verify` after each + GHA green)
- [ ] OBSERVE (EXPLAIN captured for messages-with-reactions
      query; rate limit metrics visible; reactions E2E trace
      uploaded)
- [ ] REFACTOR
- [ ] REPORT (PR.md, reviewer spawned, eval added, direct merge
      to develop with the canonical commit message)
