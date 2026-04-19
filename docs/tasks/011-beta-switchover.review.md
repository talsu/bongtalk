# Reviewer subagent — Task 011 Beta Switchover

## Header

- Branch reviewed: `feat/task-011-beta-switchover`
- Diff range: `954bcd3..06e8937` (develop..HEAD)
- Reviewer model: Opus 4.7 (1M context)
- Transcript length / tokens: ~52k prompt / ~5k output
- Commits: 5 (1 task doc + 4 chunk commits A/B/C/D)

## Verdict: request-changes

Four crisp chunks, clean commit topology, and the implementer stayed
honest about what did and didn't run locally. C (009 MED cleanup) reads
almost line-for-line against the task contract and the test coverage is
the best in the diff. B (mention notifications) is genuinely tight: the
outbox fan-out per mentioned user, the `'UserMention'` aggregate, the
replay-buffer scope `'user'`, and the sidebar badge all fit the
existing realtime shape. D (CI) rewrote the two workflows credibly and
the compose file is sensible.

But two items in A (switchover automation) and B (mention backend) are
**actually broken the first time someone runs them against the target
environment**, not just "need a tweak". The nginx-conf edit script
assumes the file ends with the outermost `}` of an `http { }` wrapper;
the NAS `nginx.conf` is an include-fragment with no such wrapper — the
last `}` closes the final `server` block, so the script splices the
deploy block _inside_ that server block and leaves a bare `}` dangling
at EOF. `nginx -t` catches it and auto-rollback fires (safety
preserved) but step 9 of the switchover checklist will never pass. And
the `CREATE INDEX CONCURRENTLY` migration will fail against
`prisma migrate deploy` because Prisma wraps each migration file in a
transaction — this means the api container will fail to boot under the
new e2e compose stack, and the `test:e2e` GHA workflow will fail on its
first push (exactly the pipeline this task was supposed to turn on).

The single highest-risk item is the Prisma × CONCURRENTLY incompatibility:
it's the whole of chunk B's database plumbing wedged against the whole
of chunk D's CI pipeline. Safe to merge once A-finding-1 and
B-finding-1 are fixed forward; the rest are MED/LOW/NIT.

## Findings

### 1. `apply-nginx-diff.sh` splices the new block inside the last server block

**HIGH** — `scripts/setup/apply-nginx-diff.sh:99-110`. The comment at
:103-104 claims "nginx.conf's final line is the http block's `}`.
Verified by reading the current file in the task-011 UNDERSTAND pass."
Verify against `/volume2/dockers/nginx/nginx.conf` on this NAS:

- `grep '^http\s*\{' nginx.conf` → **no matches**. There's no `http { }`
  wrapper. The file is an include-fragment used by the shared
  `nginx-proxy-1` container; `map`, `upstream`, and `server` blocks
  live at the top level (see the file's first 50 lines for the
  `resolver`, `map`, and `upstream` declarations).
- `grep -n '^}' nginx.conf` → closing `}` at lines 295, 328, 359, 380, 403. Line 403 is the outermost `}` of the **last `server` block**,
  not of an enclosing http context.

So the `head -n -1 … printf '%s\n' "$BLOCK" >> … tail -n 1 >>` pattern
produces:

```
server { ... last original server block, listen 443 for qufox ...
    location / {
        ...
    }                        # line 402 (inner location's `}`)
                             # <-- head -n -1 stripped line 403 here
server {                     # <-- our new block starts here
    listen 443 ssl http2;
    server_name deploy.qufox.com;
    ...
}                            # new block's own `}`
}                            # <-- tail -n 1 re-added original line 403
```

Nginx parses this as a `server` directive nested inside another
`server` block (illegal — `server` is only valid at `http` context),
followed by a stray `}` at EOF. `nginx -t` returns non-zero, the
script's line 116 restores `.bak.<epoch>`, and the operator sees:

```
nginx: [emerg] "server" directive is not allowed here
apply-nginx-diff: nginx -t FAILED — restoring /volume2/dockers/nginx/nginx.conf.bak.<stamp>
```

Safety is preserved (the nginx is unchanged, the .bak is clean, no
reload fires). But step 9 of `docs/ops/switchover-checklist.md:33` can
never succeed — the operator will hit this on switchover day.

**Fix options** (pick one):

1. Append the block at EOF (don't try to put it inside any wrapper).
   This file has no http block to preserve the meaning of "inside";
   a top-level server block is correct for an include-fragment. Drop
   the head/tail dance entirely:
   ```sh
   printf '%s\n' "$BLOCK" >> "$NGINX_CONF"
   ```
   Downside: won't work if some other deployment has the real
   `http { … }` wrapper. But the task doc pins the target file as the
   current NAS one, which doesn't.
2. Actually detect whether an `http { … }` wrapper exists; if yes,
   insert before its final `}` via a line-scan for the last line
   that's `^}\s*$` _after_ the line matching `^http\s*{`; if no,
   append. More robust, ~15 lines of awk.
3. Use the upstream pattern of a dedicated
   `/etc/nginx/conf.d/deploy.qufox.com.conf` include file and have
   the script drop it there instead of splicing into a shared file.
   This is what most ops runbooks ship by default; the nginx.conf
   here doesn't appear to use conf.d but the runbook could be
   updated to include a conf.d directory.

Option 1 is the 3-line fix and matches how the current file is
actually structured.

### 2. `CREATE INDEX CONCURRENTLY` inside a Prisma migration will fail under `migrate deploy`

**HIGH** — `apps/api/prisma/migrations/20260420000000_add_mentions_gin_index/migration.sql:6`
uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`. Postgres rejects
CONCURRENTLY inside a transaction block with
`ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.
Prisma 5.22's `migrate deploy` wraps each migration `.sql` file in a
single transaction (see
https://github.com/prisma/prisma/issues/11238 — still open, no auto-
detection of non-transactional statements).

This manifests in three places:

- `docker-compose.test.yml` → `test-api` Dockerfile `CMD` runs
  `prisma migrate deploy` on boot (`apps/api/Dockerfile:39`). The
  migration fails → the api container never flips healthy →
  `e2e.yml:37-50` `Wait for /readyz` loops for 60s then dumps logs and
  exits 1. **The e2e workflow will fail on its first push.**
- `apps/api/test/int/messages/helpers.ts:70` and the 5 sibling
  `helpers.ts` files under `apps/api/test/int/*/` call
  `execSync('pnpm exec prisma migrate deploy', …)` during setup.
  Same failure → every integration spec that depends on the messages
  module fails to boot. `integration.yml:44` `pnpm test:int` fails on
  first push.
- Production deploy: when the auto-deploy path recreates the api
  container on the NAS, the CMD's `prisma migrate deploy` step will
  fail against the existing prod DB. The old container is already
  gone (depending on compose recreate strategy) → the prod api goes
  down with no rollback path except manual `prisma db execute`.

**Fix options**:

1. Move the CONCURRENTLY statement out of migrations entirely. Create
   it via a dedicated init script that runs after migrate deploy, and
   use a plain `CREATE INDEX … USING GIN` inside a new migration
   (takes a brief exclusive lock; on a small messages table during
   beta this is seconds). This is the cheapest and safest fix.
2. Split the CONCURRENTLY migration so the file contains **only** the
   single statement, then apply it via a raw `psql` step in the
   container entrypoint before `migrate deploy` runs — by touching
   `_prisma_migrations` you can tell Prisma "already applied". Fragile.
3. Drop CONCURRENTLY. On beta the messages table is small (< 1k rows
   at switchover) and a plain `CREATE INDEX … USING GIN` locks the
   table for ~ms. Revisit once the table grows.

Option 3 is one character of diff. Option 1 is cleaner long-term. The
PR body at `docs/tasks/011-beta-switchover.PR.md:41` mentions the
CONCURRENTLY as a deliberate choice — the author appears unaware of
the Prisma transaction wrapper. Verify by attempting `pnpm test:int`
on GHA before merge: **this is the `[ ]` unchecked item in the PR
body's test plan, and the failure is predictable.**

### 3. `/me/mentions` leaks mentions after workspace kick

**MED** — `apps/api/src/me/me-mentions.service.ts:48-66` and
`apps/api/src/me/me-mentions.controller.ts:17-30`. The SQL joins
`Channel` to lift `workspaceId` but **never checks
`WorkspaceMember(userId=:caller)`**. If an admin removes me from
workspace W, my old `mention.received` rows on W's messages still
surface on `GET /me/mentions`. Same deal for channels: the query
walks all messages across every channel without checking I'm still a
member.

Impact: a removed member can keep polling `/me/mentions` and see
post-removal mentions (well — they see the mentions they got BEFORE
removal; the workspace enforcement is at write time, so no new
mentions will be emitted for them. But pre-existing ones remain
visible). The snippet they see already leaked to them at the time it
was posted, so this is a leak of "what was already exposed" rather
than an escalation. Still — the mental model the task doc proposes
("workspaces are the trust boundary") is violated.

**Fix**: add `JOIN "WorkspaceMember" wm ON wm."workspaceId" =
c."workspaceId" AND wm."userId" = :userId` — at most one row per
membership, uses the existing unique index at `schema.prisma` on
`(userId, workspaceId)`. Filters both leaks in one hop.

Edge case to document: whether `@everyone` mentions in workspaces the
caller has since left should show (currently yes, for the same
reason). Probably no, for the same fix.

### 4. Prod-reload has no "break-glass" path once it shares the flock

**MED** — `scripts/prod-reload.sh:19-21` sources `deploy/lock.sh` and
does `deploy::acquire_lock || exit $?`. If the webhook is wedged
holding the flock (stuck in the middle of `auto-deploy.sh`, or the
process died without `deploy::release_lock` running — the
`EXIT` trap doesn't fire on `SIGKILL`), the operator's muscle-memory
"just run `prod-reload.sh`" now exits 75 immediately. The old behavior
was at-least-it-starts-a-build; the new behavior gives nothing.

The audit.jsonl + `docker logs qufox-webhook` will tell the operator
what happened, but under pressure they'll reach for prod-reload and
get blocked. Operator trust in the manual path is the whole reason
it's a manual path.

**Fix options**:

1. `scripts/prod-reload.sh --force` skips the flock and logs a warning
   to `/volume2/dockers/qufox/.deploy/audit.jsonl` (an operator can
   see "manual deploy overrode lock at T").
2. Document a "break the lock" step in
   `docs/ops/switchover-checklist.md § If something breaks` — the
   existing text at line 55 says "shares the flock with the webhook"
   but doesn't say how to break it. `rm -f
/volume2/dockers/qufox/.deploy/deploy.lock && docker exec
qufox-webhook pkill -f auto-deploy.sh` is the clean sequence; the
   current runbook doesn't list it.
3. Use `flock -w 30 9` instead of `-n 9` in prod-reload.sh so manual
   callers block up to 30s before giving up. Matches operator
   expectation "wait a bit then complain."

Option 2 is the cheapest. Option 1 is the most operator-friendly.

### 5. `e2e.yml` Playwright config may not use the compose-exposed ports

**MED** — `.github/workflows/e2e.yml:57-60` passes
`PLAYWRIGHT_BASE_URL=http://localhost:45173` and
`VITE_API_URL=http://localhost:43001` as env vars. But
`docker-compose.test.yml:77` maps `test-web` to `:45173` (host) → `:80`
(container) and `test-api` to `:43001` → `:3001`. So the ports land as
expected from the host (GHA runner) perspective, good. However:

- `test-web` is built from `apps/web/Dockerfile` which bakes the
  production Vite build. `VITE_API_URL` at build time, not runtime,
  controls where the browser talks. The compose file only sets
  `NODE_ENV=test` at runtime (line 76) — there's no build arg for
  `VITE_API_URL`. If `apps/web/Dockerfile` has a baked-in
  `VITE_API_URL=/api` or similar, the browser in the E2E will point
  at `http://localhost:45173/api`, not `http://localhost:43001`. That
  would break every test that hits the API directly via the UI.
- Existing e2e tests (check
  `apps/web/e2e/realtime/mention-notification.e2e.ts:4`) use
  `http://localhost:43001` via `ctx.request.post(…)`, which is the
  direct-to-API path (not the UI-proxied path). That WILL work from
  the GHA runner because the compose exposes 43001. Good.
- But for UI-driven flows (login form, channel creation via the UI),
  the browser inside the playwright process still hits whatever
  VITE_API_URL was BAKED into `test-web`. Without seeing
  `apps/web/Dockerfile` I can't confirm — flag as "verify the first
  GHA run actually passes the UI-driven tests."

**Fix (if broken)**: add a build arg to `docker-compose.test.yml` for
`test-web`: `build: { args: { VITE_API_URL: http://localhost:43001 } }`
and ensure `apps/web/Dockerfile` accepts it.

### 6. `init-env-deploy.sh` POSTGRES_PW precondition is cosmetic only

**LOW** — `scripts/setup/init-env-deploy.sh:43-47` reads
`POSTGRES_PASSWORD` from `.env.prod` purely as a **precondition check**
(it's only echoed during `--dry-run` and never written to the target
file). So the question in the review brief about "what if the value
contains `=` signs" is answered by `cut -d'=' -f2-` (note the `-f2-`
— takes every field from 2 onward joined by `=`), which handles
base64 / PBKDF values fine. Also safe for single-line values.

What IS genuinely fragile:

- `POSTGRES_PASSWORD="foo=bar"` (quoted in the env file) — `cut` returns
  `"foo=bar"` verbatim, but the wc -c in the dry-run echo counts the
  quotes. Low impact.
- If the env file has `export POSTGRES_PASSWORD=…` prefix, the
  `^POSTGRES_PASSWORD=` anchor misses. `.env.prod.example` doesn't
  use `export` so this is a non-issue in practice, but future-proof
  by allowing `^(export )?POSTGRES_PASSWORD=`.

Cosmetic fix; flag only because the task contract explicitly mentions
"reads POSTGRES_PASSWORD from .env.prod instead of duplicating the
value" and the reader might think the value flows through.

### 7. Mention-bomb fan-out writes N outbox rows per message

**LOW** — `apps/api/src/messages/messages.service.ts:157-178`. A
message `@mentioning 500 workspace members` writes 500
`UserMention` outbox rows inside a single Prisma transaction. Open
questions:

- Prisma `$transaction` over 500 `tx.outboxEvent.create` calls:
  measurable latency bump (~2-5s on the NAS DB). The `messages.send`
  controller's response won't return until the transaction commits.
  Under the default 30s prisma timeout, fine; under worse conditions
  (slow disk), risk of a p99 spike.
- The outbox dispatcher runs every 250ms and the default batch size
  is 50 (`docker-compose.test.yml:52-53`). 500 fan-out events + the
  dispatch interval = 2.5 seconds to drain, so the recipient toasts
  trickle in over ~2.5s. Fine for the current threshold (5 toasts/sec
  → collapse kicks in immediately anyway).
- No cap on the number of users a single message can mention. A
  hostile member could `@alice @bob @carol …` 1000× and spam the
  outbox. Rate limit is only on `POST /messages` (once per user per
  second), so the damage is ~1 message/sec × all users fan-out.

Mitigate later; tactically fine for beta.

**Suggested follow-up**: cap `mentions.users.length` at 50 in
`extractMentions` (silently truncate) or fail validation at 200.
`MessagesService.send` is the right place for the cap.

### 8. `MentionThrottle.collapseOne` can lose the first collapsed count on a race

**LOW** — `apps/web/src/features/realtime/dispatcher.ts:66-75`. Walk
the scenario in the brief:

1. Burst 1: 10 mentions arrive in 100ms. First 5 consume tokens, 5 call
   `collapseOne`. `this.collapsed = 5`, `collapsedTimer` set for
   +1000ms.
2. At +1000ms: timer fires, `total = 5`, `collapsed = 0`, timer = null,
   emits "5 more mentions" toast. **This works.**
3. Burst 2: during that 1s window (say at t=800ms), 5 more mentions
   arrive. Tokens refill linearly — at t=800ms, tokens ≈ 4, so the
   first 4 of this burst fire real toasts, the 5th calls
   `collapseOne`. `this.collapsed = 6`, timer is still the original
   (set at t=0ms for t=1000ms fire), so `if (this.collapsedTimer)
return` skips. The 6th mention joins the first 5.
4. At t=1000ms: timer fires with `total = 6`. Good.

So the counter DOES accumulate correctly across the same timer
window. The race I expected (second burst creating a second timer,
overlapping with the first) doesn't happen because of the
`if (this.collapsedTimer) return` guard at line 68. Clean.

What COULD go wrong: if burst 2 starts at t=1001ms, _after_ the first
timer fired but before any React state flushes, the new timer is set
at t=1001ms for t=2001ms. Five mentions in that burst produce one
collapsed toast at t=2001ms. Fine.

There's no test for `MentionThrottle`. Consider adding one — the
token-bucket + collapse-timer logic is the kind of thing that breaks
silently under clock drift / fake timers.

**Suggested follow-up**: add `apps/web/src/features/realtime/
mention-throttle.spec.ts` with `vi.useFakeTimers()` driving the two
bursts above.

### 9. `navigate` via `pushState + popstate` may not refresh React Router's URL params

**LOW** — `apps/web/src/features/realtime/useRealtimeConnection.ts:72-77`.

```ts
navigate: (url) => {
  window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
```

React Router v6 does listen for `popstate` events, so the route DOES
re-render. However, the router distinguishes `PUSH` from `POP`
navigation for scroll restoration — this trick emits a `POP`, which
won't auto-scroll to top on the channel change (probably fine for
chat, where you want to scroll to the mentioned message anyway).

More concerning: if the browser's `popstate` listener fires before
React processes the pushed state, the `location.search` read by the
MessageColumn's `useSearchParams()` will be correct (it reads
`window.location` directly). So `?msg=<id>` should be picked up by the
around-anchor hook.

No bug, flag as "verify in E2E run" — the
`mention-notification.e2e.ts:109` asserts the URL contains `?msg=`,
which is a URL-level test, not a "did the app scroll to the message"
test. Add an assertion that the mentioned message row becomes visible
(something like `await expect(page.locator(\`[data-message-id=\${id}]\`)).toBeVisible()`).

### 10. Deleted CI workflows were also placeholders — but the task said the other two

**LOW** — The task contract at `docs/tasks/011-beta-switchover.md:140-142`
said: "Drop the existing `.github/workflows/integration.yml` and
`.github/workflows/e2e.yml` placeholders that print TODO(task-010) —
they're empty shells today." In fact, the existing `integration.yml`
on `develop` at `954bcd3` is already a real 45-line service-container
pipeline (no `TODO(task-010)` lines) and `e2e.yml` is a similar real
workflow. They weren't placeholders.

The author correctly identified that `deploy-prod.yml`,
`deploy-staging.yml`, and `db-migrate.yml` WERE placeholders full of
`echo "TODO(task-010):…"` lines and deleted those instead. That's a
sensible correction — a K8s canary deploy isn't shipping in this
task. But the task contract wasn't updated to reflect the scope shift.
The PR body at :77-80 mentions the substitution in passing.

**Fix**: add a sentence to `docs/tasks/011-beta-switchover.md` under
"D. CI test pipeline" noting that the task-contract line about
dropping integration.yml + e2e.yml placeholders turned out to be
stale (they were already real workflows on develop), and the
deleted-placeholders were the three K8s deploy ones instead. Zero
runtime impact; just keeps the task trail honest.

### 11. `ensureDir` memoisation on a rejected promise would wedge audits — benign in practice

**NIT (positive)** — I spot-checked the concern raised by the brief:
`services/webhook/src/audit.ts:49-54` memoises the mkdir promise on
`this.readyPromise`. If mkdir rejects with EACCES, `readyPromise`
stays rejected and every subsequent `append()` re-awaits the rejected
promise. But the outer `try/catch` at lines 63-71 swallows the
rejection and writes to stderr. The chain's link resolves (the inner
`.then(async () => { try {…} catch {…} })` never propagates the
rejection out), so future appends are NOT blocked.

So the reviewer-brief's concern ("rejected → wedged") doesn't
materialise. The visible effect is every append produces one stderr
line noting the failure, which is fine for a best-effort audit log on
a misconfigured host.

### 12. Honest AC gap — E2E and test:int not run locally

**NIT (already disclosed)** — `docs/tasks/011-beta-switchover.PR.md:104-108`
admits `test:int` and `test:e2e` were not run on the NAS. The task
contract at `docs/tasks/011-beta-switchover.md:160` explicitly says
"NAS-not-run is no longer accepted as a deferral" and expects GHA to
catch them. With findings #2 and #5 above, the first GHA run is
predictable to fail. This isn't a reviewer finding per se — it's the
AC enforcement gate doing exactly what the task contract said it
would do.

### 13. Items that look good (compliments)

- **Four-chunk commit topology is clean.** Each chunk stands alone:
  `5b45136 A`, `06e8937 B`, `90c0021 C`, `e5d966c D`. The C commit
  maps each MED-fix to the 009 review line in its body; future
  `git blame` will find the rationale quickly.
- **`scripts/backup/redis-backup.sh` MED-4 fix is textbook.** The
  `initial=LASTSAVE` before BGSAVE, the `BGSAVE_REPLY` assert for
  "Background saving started", and the 60s strict-advance poll are
  exactly the right three asserts. Lines 38-63 are the cleanest
  redis-backup shape I've seen in this repo.
- **`AuditLog` serialised-via-promise-chain pattern (services/webhook/
  src/audit.ts:36-75) is the right call for the constraint** (no
  external logrotate, no in-process lock, concurrent appends must not
  interleave with rename). The test at `audit-rotation.spec.ts`
  exercises both the happy path and the maxFiles-capped drop path.
- **`scripts/deploy/test-lock-shared.sh` proves the flock-sharing
  semantic at the shell level.** The "start a holder in a subshell,
  invoke `deploy::acquire_lock` in a sibling" pattern is brittle to
  write but correct — exits 0 on the expected-block path, non-zero
  if the lock mysteriously grants twice.
- **`MeMentionsService.unreadCount` reuses `UserChannelReadState.
lastReadAt` instead of a new `MentionReadState` table** — this is
  the single best product decision in the task. Opening the channel
  clears its mentions "for free", no migrations, no dangling
  mention-acknowledge endpoint.
- **Outbox `UserMention` aggregate split + `mention.**`@OnEvent
wildcard routing** is a tidy extension of the task-005 realtime
shape. Replay-buffer scope`'user'`at`outbox-to-ws.subscriber.ts:68`
  means a reconnecting user catches up on mentions they missed while
  offline — no extra plumbing.
- **`buildSnippet` at messages.service.ts:27-30** whitespace-collapses
  ≤140 chars so the toast body is self-contained even before the
  client has `GET /me/mentions` cached. Avoids a roundtrip.
- **Sidebar `@ 멘션` badge at ChannelColumn.tsx:185-196** — the
  `99+` cap is the classic iOS pattern, and the `aria-label` gets
  the accurate count for screen readers. Accessible without being
  ugly.
- **`docker-compose.test.yml`** matches the production topology
  closely enough to flush out e2e env-var drift (the kind of bug
  "works on my laptop, breaks in CI" grows out of).
- **Switchover checklist table format** — 4-column (action / automation
  / validation / rollback) is the right shape for an ops runbook.
  Future `docs/ops/*.md` should use the same template.
- **`MentionThrottle.collapseOne` guard** at dispatcher.ts:68
  (`if (this.collapsedTimer) return`) — the reviewer brief was right
  to ask about the race, and the answer is "the guard closes it."
  Clean.
- \*\*`scripts/setup/init-env-deploy.sh` refuse-to-overwrite + --dry-run
  - single-shot secret echo\*\* all match the task doc to the letter.
    The refuse-to-overwrite exit 3 prints a clear "move/rename first"
    recovery hint.

## Suggested follow-up TODOs

- **TODO(task-011-follow-1)**: rewrite `apply-nginx-diff.sh` insert
  logic (finding #1). Simplest: append the block at EOF.
- **TODO(task-011-follow-2)**: drop `CONCURRENTLY` from
  `20260420000000_add_mentions_gin_index/migration.sql` OR move the
  concurrent index build into a post-migrate init script (finding
  #2). Required for e2e.yml and integration.yml to go green on GHA.
- **TODO(task-011-follow-3)**: add `WorkspaceMember` join to
  `/me/mentions` SQL so kicked members don't see retained mentions
  (finding #3). One-line JOIN.
- **TODO(task-011-follow-4)**: document (or add) a `--force` flag to
  `prod-reload.sh` and an "if the lock is stuck" runbook step
  (finding #4).
- **TODO(task-011-follow-5)**: verify `VITE_API_URL` threading
  through `test-web`'s build in `docker-compose.test.yml` (finding
  #5). If the Dockerfile already accepts it, no-op; if not, add the
  build arg.
- **TODO(task-011-follow-6)**: cap `mentions.users.length` at a sane
  upper bound (finding #7) to prevent mention-bomb outbox writes.
- **TODO(task-011-follow-7)**: unit test for `MentionThrottle` with
  fake timers (finding #8).
- **TODO(task-011-follow-8)**: add `await expect(page.locator(
[data-message-id=…])).toBeVisible()` to `mention-notification.e2e.
ts` so the "jump" is verified at the DOM level, not just URL
  (finding #9).
- **TODO(task-011-follow-9)**: reconcile the task doc's "drop
  integration.yml + e2e.yml placeholders" line with what was actually
  deleted (finding #10). Doc-only update.

## Resolution (task-011 reviewer response — commit 2c3ad4b)

HIGH + MED fixed forward on `feat/task-011-beta-switchover`.
LOW/NIT carried as `TODO(task-011-follow-*)` markers above.

| Finding                                              | Severity | Resolution                                                                                                                                                                                                               |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. apply-nginx-diff splices inside last server block | HIGH     | **Fixed**: `scripts/setup/apply-nginx-diff.sh` now appends at EOF. The NAS file has no `http { }` wrapper; a top-level server block is correct for an include-fragment. `nginx -t` auto-rollback remains the safety net. |
| 2. CREATE INDEX CONCURRENTLY inside Prisma migration | HIGH     | **Fixed**: `20260420000000_add_mentions_gin_index/migration.sql` drops `CONCURRENTLY`. Comment documents the Prisma tx-wrapper incompatibility + the revisit condition (~100k rows).                                     |
| 3. /me/mentions leaks mentions after workspace kick  | MED      | **Fixed**: both `recent()` and `unreadCount()` in `me-mentions.service.ts` JOIN `WorkspaceMember` scoped to the caller.                                                                                                  |
| 4. prod-reload break-glass                           | MED      | **Fixed**: `--force` flag in `scripts/prod-reload.sh` bypasses the flock and writes `manual.force-unlock` to `.deploy/audit.jsonl`. `docs/ops/switchover-checklist.md` gains a "deploy lock is stuck" recovery block.    |
| 5. VITE_API_URL not threaded into test-web           | MED      | **Fixed**: `apps/web/Dockerfile` declares `ARG VITE_API_URL=/api` + `ENV VITE_API_URL=${VITE_API_URL}`; `docker-compose.test.yml` passes `VITE_API_URL=http://localhost:43001` via `build.args`.                         |
| 6-10. LOW items                                      | LOW      | Carried as `TODO(task-011-follow-*)` markers; see the follow-up list above.                                                                                                                                              |
| 11-12. NIT positives / AC gap                        | NIT      | Noted; GHA enforces test:int / test:e2e on push.                                                                                                                                                                         |

## Re-review (post-fix 2c3ad4b)

- Model: Opus 4.7 (1M context)
- Transcript: ~18k prompt / ~1.5k output

### Verdict: approve

All 5 reviewer findings are genuinely closed on disk. The fix commit
is small (~85 source-line delta across `scripts/setup/apply-nginx-diff.sh`,
`scripts/prod-reload.sh`, `apps/api/prisma/migrations/.../migration.sql`,
`apps/api/src/me/me-mentions.service.ts`, `apps/web/Dockerfile`,
`docker-compose.test.yml`, `docs/ops/switchover-checklist.md`), targeted,
and each hunk carries an inline `task-011 reviewer <FINDING> fix:`
comment that makes the rationale discoverable via `git blame`. The
`## Resolution` table above accurately reflects what's on disk.
No new issues detected in the fix diff.

### Per-finding status

1. **HIGH-1 apply-nginx-diff** — resolved.
   `scripts/setup/apply-nginx-diff.sh:99-107` now does a plain
   `printf '%s\n' "$BLOCK" >> "$NGINX_CONF"`. Verified against
   `/volume2/dockers/nginx/nginx.conf:403` (last line is the final
   `server` block's `}`, no `http { }` wrapper), so appending a
   top-level `server` block produces valid nginx for the NAS target.
   The defensive `nginx -t` + auto-rollback gate at :110-115 is
   retained for the hypothetical case where another deployment ships
   an outer http wrapper.

2. **HIGH-2 CONCURRENTLY** — resolved.
   `apps/api/prisma/migrations/20260420000000_add_mentions_gin_index/migration.sql:14-16`
   now uses `CREATE INDEX IF NOT EXISTS "Message_mentions_gin_idx" ON
"Message" USING GIN ("mentions") WHERE "deletedAt" IS NULL;`. This
   runs cleanly inside Prisma's per-migration transaction wrapper.
   `IF NOT EXISTS` on plain `CREATE INDEX` is supported on PG 11+
   (prod is PG 16, confirmed in CLAUDE.md stack); partial-index
   `WHERE` clause is vanilla SQL. No residual Prisma gotchas.

3. **MED-3 /me/mentions ACL** — resolved.
   `apps/api/src/me/me-mentions.service.ts:62-64` (recent) and
   `:97-99` (unreadCount) both add `JOIN "WorkspaceMember" wm ON
wm."workspaceId" = c."workspaceId" AND wm."userId" = ${userId}::uuid`.
   Uses the composite PK `@@id([workspaceId, userId])` at
   `apps/api/prisma/schema.prisma:108` — single index lookup per row,
   no perf regression. Airtight for both user-level and `@everyone`
   mention paths: a caller with no `WorkspaceMember` row for workspace
   W gets zero rows from W regardless of which mention predicate
   matched. Notably, this also closes a residual leak path the OLD
   code had independent of kicking — `@everyone` mentions in any
   workspace where the caller was NEVER a member would previously
   have surfaced (the only author-filter was `authorId <> userId`);
   the new code filters those too.

4. **MED-4 prod-reload break-glass** — resolved.
   Shell flow at `scripts/prod-reload.sh:21-43`: the `for a in "$@"`
   loop splits `--force` into `FORCE=1` and everything else into
   `ARGS[@]`, so `prod-reload.sh --force api` correctly sets
   `TARGET=api` via `ARGS[0]` at :45. In the force branch (:36-39)
   the script writes one JSON line to `.deploy/audit.jsonl` — format
   `{"ts":"2026-04-20T12:34:56Z","event":"manual.force-unlock","source":"prod-reload.sh"}\n`
   which is valid JSON (no embedded quotes; Z-suffixed ISO-8601 ts).
   The else branch (:40-43) preserves the original `acquire_lock` +
   EXIT-trap behaviour. Runbook text at
   `docs/ops/switchover-checklist.md:57-86` describes both the clean
   recovery (`docker restart qufox-webhook` + `rm -f .deploy/deploy.lock`)
   and the emergency `--force` override; the text matches what the
   script actually does.

5. **MED-5 VITE_API_URL** — resolved.
   `apps/web/Dockerfile:26-27` declares `ARG VITE_API_URL=/api`
   followed by `ENV VITE_API_URL=${VITE_API_URL}` BEFORE the
   `pnpm --filter @qufox/web build` step at :28-29. Vite reads `VITE_*`
   from `process.env` at build time, so the baked bundle picks up
   whatever the compose stack supplied. `docker-compose.test.yml:74-79`
   passes `build.args.VITE_API_URL: http://localhost:43001`; confirmed
   the web app reads it at `apps/web/src/lib/api.ts:11`,
   `lib/socket.ts:15`, and `features/messages/api.ts:74` via
   `import.meta.env.VITE_API_URL` with `/api` fallback. The prod build
   (default ARG) keeps pointing at the nginx proxy, the e2e build
   points directly at the host-exposed test-api port. Wiring is
   correct end-to-end.

### New issues

None. The fix diff is minimal, localised, and contains no piggy-backed
refactors. One benign observation: `scripts/prod-reload.sh:34`
unconditionally sources `deploy/lock.sh` even when `--force` skips the
lock — harmless (function definitions only, no side effects), so no
change requested.

Side note on the brief: the re-review prompt claimed a `## Resolution`
section mapping findings to fixes was appended. That section DOES
exist (lines 513-526) and DOES accurately reflect the commit.

### Merge recommendation

Safe to merge as-is. Previous follow-up TODOs 1-5 are now closed by
`2c3ad4b`; TODOs 6-9 remain as deferred low-priority follow-ups per
the original review.
