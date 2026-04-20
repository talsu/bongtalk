# Reviewer subagent — Task 010 Beta Polish

## Header

- Branch reviewed: `feat/task-010-beta-polish`
- Diff range: `c34f489..7106382` (develop..HEAD)
- Reviewer model: Opus 4.7 (1M context)
- Transcript length / tokens: ~42k prompt / ~5.5k output
- Commits: 6 (5 chunk + 1 docs)

## Verdict: request-changes

The diff is cleaner than I expected — five crisp chunk-commits, honest
about the two ACs that weren't actually executed (`test:int`,
`test:e2e`), and the 009 BLOCKERs from the spawned-reviewer report are
all resolved forward on this branch. Task-010-A (process debt), D
(observability) and E (002 ageing) read almost line-for-line against
their task-contract entries. But Task 010-B ships a real visible UX bug:
the dispatcher hard-wires `activeChannelId` to `null`, so the numeric
unread pill (which is never gated on `!active`) will bump upward on the
channel the user is actively reading. The single highest-risk item is
that regression — beta users will immediately see "a channel I'm
looking at says 3 unread" and file a bug. It's a ~4-line fix but it
undermines the whole chunk. The other finding at this level is a
double-booked `TODO(task-011/12/13)` namespace, which is harness
hygiene rather than runtime danger. Overall I'd request changes, fix
the pill, and merge.

## Findings

### 1. Unread pill bumps on the channel the user is actively viewing

**HIGH** — `apps/web/src/features/realtime/useRealtimeConnection.ts:46`
hard-wires `activeChannelId: () => null`, and the comment in the same
file explicitly acknowledges the "acceptable false-positive" trade.
Walk the scenario:

1. Alice is reading `#general`. On mount, `MessageColumn.tsx:36-48`
   fires a 500ms-debounced `POST /read` → cache goes to `unreadCount: 0`.
2. Bob posts in `#general`. Dispatcher receives `message.created`.
3. `dispatcher.ts:50` evaluates `active !== env.channelId` — but
   `active` is `null`, so the guard is always truthy; the cache is
   bumped to `unreadCount: 1`.
4. Alice's `MessageColumn` `useEffect` deps are `[channelId]` only
   (file:35-48), so nothing re-fires the debounced `POST /read`. The
   cache stays at 1 until Alice navigates away and back.
5. `ChannelList.tsx:168` computes `hasUnread = !active && count > 0`
   — the dot is correctly gated on `!active`, so Alice doesn't see a
   dot. But line 198 passes the unfiltered `u?.count` into
   `<UnreadIndicator>`, which at `ChannelList.tsx:40-50` renders as
   long as `count > 0`, regardless of active. Same bug at line 110
   for the `ChannelRow` variant.

Result: the user sees an increasing numeric pill on the channel they
are staring at. That's a shipping bug on the very chunk whose whole
purpose is unread UX. The task commit message claims "an open channel
drives its own POST /read after 500ms debounce, which zeroes the
count" — true only on mount, not on subsequent arrivals while the user
stays put.

**Fix options** (pick one):

- Gate `UnreadIndicator` on `!active` the same way the dot is:
  `ChannelList.tsx:110` → `<UnreadIndicator count={active ? 0 :
unreadCount} …/>`, same at `:198`. Cheapest.
- Actually implement `activeChannelId` in
  `useRealtimeConnection.ts:46` by reading the active channel from
  `useParams` / route state via a ref so the closure stays stable.
- In `MessageColumn.tsx`, subscribe to `message.created` and re-fire
  the debounced POST (or call `useMarkChannelRead.mutate` directly).

The third option matches Discord's semantic: messages you saw arrive
while looking at the channel are "read." The first option is the
narrowest change and still correct visually.

### 2. `TODO(task-011)`, `TODO(task-012)`, `TODO(task-013)` collide with task-001's PR body

**MED** — `docs/tasks/001-auth.PR.md:54-56` already claims those
numbers for `password reset`, `email verification`, and `session
management UI` respectively. Task 010-E's commit message and in-code
TODOs at `apps/api/src/workspaces/invites/invites.controller.ts:101`,
`apps/api/src/workspaces/invites/invites.service.ts:168`,
`apps/api/src/workspaces/workspaces.service.ts:170` claim the same
three numbers for invite rate-limit, CAS error fidelity, and
transferOwnership serializable isolation.

`grep -rn 'TODO(task-011)'` returns matches from both tasks-1 (PR body
only) and task-010-E (live code). Future-you will not know which task
doc to open when actioning the TODO. The 002-workspace.PR.md:89
already claims `TODO(task-014)` for "invite + soft-delete purge
batch", and task-010-E also claims it — at least that one is
consistent semantically ("soft-delete purge worker") but it's still
the same task number being claimed in two different docs.

**Fix**: renumber task-010-E's markers to the next free range
(task-028+ seems unused; grep for `TODO(task-02[0-9])` to verify).
Update `docs/tasks/010-beta-polish.md:124-133` and the four call sites.
Alternatively, turn task-001.PR's follow-ups into non-binding aliases
("password-reset → will be filed later"), but that inverts which doc
is authoritative.

### 3. Dispatcher unread bump uses event payload's `message.authorId === 'optimistic'` collapse upstream, but the mention user-id is never sent

**LOW** — `apps/web/e2e/realtime/unread-propagation.e2e.ts:117-126`
says the mention variant tests "owner @mentions the member." The
payload actually sent has `users: []` and `everyone: true` (file
comments the member id isn't resolved on the client). The test
therefore verifies the `everyone` branch of the dispatcher's
`mentioned || everyone` check — it would pass even if the
`users`-containment check at `dispatcher.ts:55` were broken. The
backend integration test (`unread-summary.int.spec.ts:92-107`) does
cover real user mentions via jsonb containment, so there's production
coverage, but the E2E's comment is misleading. Rewrite the payload to
carry `users: [memberUserId]` via a lookup call (the owner token can
hit `/workspaces/:id/members` to resolve the id), or fix the comment
to say "@everyone variant" so the test name matches the shape.

### 4. `/internal/metrics` IP allowlist is broader than documented

**LOW** — `services/webhook/src/server.ts:24`:
`INTERNAL_ALLOWED_PREFIXES = ['127.', '::1', '::ffff:127.', '172.',
'10.', '192.168.']`. The comment on line 19 says "Docker bridge
range." In practice, `172.` accepts **any** IP starting `172.` —
including the public `172.x` /8 outside the RFC1918 172.16/12 block.
`10.` covers 10/8 which IS RFC1918, but a container on any joined
network can reach the endpoint. On the Synology NAS where the webhook
sits on the `internal` bridge, any other container on that network
(qufox-web, qufox-api, qufox-backup) can POST
`/internal/rollback-reported` and spuriously bump the rollbacks
counter. The counter is a metric, not a gate, so this is low impact —
but the allowlist promise is stronger than the code. At minimum:
narrow to the observed docker bridge subnet (e.g. `172.17.` or
`172.18.`), or switch to a shared-secret header and document the
rotation step in `runbook-secret-rotation.md`. The existing
`TODO(task-010-k8s-prep)` in
`infra/k8s/monitoring/servicemonitor-webhook.yaml:21` already flags
that K8s service CIDRs won't match anyway — this is the same class of
problem in the docker-compose deploy shape.

### 5. ESLint palette rule won't catch template-literal classNames

**LOW** — `eslint.config.mjs:11` uses the selector
`Literal[value=/…/]`. Under the TS parser, a bare JSX attribute
`className="bg-red-500"` is a `Literal` node → matches. But
`className={'bg-red-500'}` is also a `Literal`, so that form is fine.
The case that escapes is `className={`bg-red-${shade}`}` or
`className={cn('bg-red-500', …)}`'s string argument inside a
template-literal — the template-literal's `quasis` elements are
`TemplateElement` nodes, not `Literal`. A developer who ports an old
component via `cn(…)` with a literal string will still be caught
(still `Literal`), but a ternary wrapped in a template like
`className={`${flag ? 'bg-red-500' : 'bg-blue-500'}`}` will parse the
colors as two `Literal` children of the `ConditionalExpression`
inside a `TemplateLiteral` — and will actually match (each is a
bare `Literal`). So the template-literal case is fine for simple
ternaries. The genuine miss is a dynamically built class name like
`` `bg-${color}-500` `` where the token is interpolated — no `Literal`
"bg-red-500" exists in the AST. Low risk (nobody writes Tailwind this
way because the JIT compiler won't see the class), but the task doc
claims the rule "matches all raw palette classes" and it doesn't. At
minimum, amend the rule comment to document the interpolation blind
spot, or add a second selector targeting
`TemplateElement[value.raw=/…/]`. The existing
`scripts/test-eslint-palette-rule.sh` fixture only exercises the
string-literal case, so the AC ("ESLint rule firing on a synthetic
hard-coded-color test file") passes without exercising the blind
spot.

### 6. Task 010-E's transferOwnership resolution note is accurate but buries the history

**NIT** — task-010-E's commit body says the 002-review item asking to
"move `emit()` outside transaction" is "already resolved upstream"
because `transferOwnership` uses `outbox.record(tx, …)`. That's correct
(`workspaces.service.ts:197-202`) — the event is persisted atomically
with the role writes, and a separate dispatcher delivers post-commit.
But the commit message conflates "no bare `emit()` inside the
transaction" with "the 002 review's concern is resolved," and the
actual review item isn't linked. Add the review-line anchor to
`docs/tasks/002-workspace.review.md` (or wherever the finding lives)
in the commit log / task-010 doc so the audit trail is intact.

### 7. `WEB_URL` dev-default check doesn't catch common variants

**NIT** — `apps/api/src/config/required-env.ts:8` uses
`new Set(['http://localhost:45173', 'http://localhost:5173'])` as an
exact-string match. Anyone who sets `WEB_URL=http://127.0.0.1:5173`,
`WEB_URL=http://localhost:5173/` (trailing slash), or
`WEB_URL=HTTP://LOCALHOST:5173` slips through. In prod that's exactly
the shape of "operator tried to test locally and forgot to change it
before deploying." The check is cheap to harden: lowercase + strip
trailing slash + match against a regex like
`^https?://(localhost|127\.0\.0\.1)(:\d+)?/?$`. Current code ships a
narrow valid guard, but it's obvious the author knows this — the task
doc calls it a "WEB_URL boot assert." Closing the loop on the
normalization is a one-liner.

### 8. E2E and integration tests for task-010 were NOT run

**NIT (already disclosed)** — `docs/tasks/010-beta-polish.PR.md:109-119`
admits `test:int` and `test:e2e` were not executed in the
implementer's environment. The Acceptance Criteria at
`docs/tasks/010-beta-polish.md:148-156` lists both as mechanical
green-gate. This is an AC-miss, not a finding of my own — flagged here
so the release-manager agent blocks on CI rather than on the
implementer's local green. `web-url-assert.int.spec.ts` is admitted to
be a pure function test that lives under `test/int/` for pipeline
plumbing only, and the metrics spec's allowlist-rejection coverage
(`services/webhook/test/metrics.spec.ts:134-141`) is a comment rather
than a test — the negative path ("bad peer 403s") is structurally
uncovered.

### 9. Reviewer-subagent spawn for 009 passes the sniff test

**NIT (positive)** — I spot-checked
`docs/tasks/009-deploy-automation.review.md` for plausibility: line 116
cites `auto-deploy.sh:82-93` and the listed code matches; lines 38-39
name `services/webhook/Dockerfile:18-19` (`docker-cli bash git curl
tini`) and that's the actual Dockerfile shape; line 75 cites
`compose.deploy.yml:23` as `env_file: [.env.deploy]` — matches the
version of compose.deploy.yml **before** this branch added the SSH
mount. The resolution table at lines 457-484 is clean and every
BLOCKER maps to a specific line in a specific commit (241cfec). The
claim "~45k prompt / ~5k output" is vague but consistent with the
findings density. Not boilerplate.

### 10. `active`-unwired comment admits a bug it doesn't fix

**NIT** — `useRealtimeConnection.ts:38-41` reads: "ActiveChannelId
defers to null — the ChannelView's POST /read call on mount + focus
will zero unread for the open channel, so a transient false-positive
(bumped then zeroed) is harmless." That comment is wrong in two ways:
(a) the POST only fires on mount, not on subsequent messages — see
finding #1; (b) even if it DID re-fire, the bump is visible for the
full 500ms debounce window — that's not "transient" for a user
glancing at the sidebar. The fact that the implementer wrote this
comment means they considered the question and waved it off; the
right outcome was a 4-line fix, not a rationalisation.

## Items that look good (compliments)

- Clean 5-commit topology, one chunk per commit, no cross-contamination.
  `241cfec` includes both the 009 process artefacts AND the BLOCKER
  fixes (A); `9a602af` is pure E; etc.
- `apps/api/src/channels/unread.service.ts` is a genuinely good piece
  of SQL: the `LEFT JOIN LATERAL` + `rs.lastReadAt IS NULL OR
createdAt > rs.lastReadAt` handles the "fresh-member" case
  elegantly, and the `msg."authorId" <> ${userId}` filter is
  correctly inside the LATERAL (not outside) so self-messages don't
  block counting others'. Index (`@@index([channelId, createdAt,
id])` at `schema.prisma:172`) covers the access pattern. The
  "EXPLAIN verified (DNA)" claim in the comment is unverifiable — no
  plan output is attached — so I'd downgrade that to "index present
  at schema.prisma:172, planner expected to pick an index scan" in
  the doc, but the query shape itself is sound.
- Guard wiring on unread controllers is correct: `workspaceId` comes
  from `CurrentMember()` payload (guard-resolved) at
  `unread.controller.ts:26`, not from `:id` params — IDOR-safe.
- `ChannelAccessGuard` rejecting archived channels at
  `channels/guards/channel-access.guard.ts:69-74` is the right call;
  POST /read on an archived channel will 409 with `CHANNEL_ARCHIVED`
  rather than silently marking it read.
- `apps/api/test/int/channels/unread-summary.int.spec.ts` is tight —
  four cases, each with a single clear invariant.
- The reviewer-subagent artefact for 009 (`review.md`) is genuinely
  excellent — line-anchored findings, specific fixes, and the
  resolution table closes the loop. Future task-NNN reviews should
  use this as the template.
- `services/webhook/src/server.ts:85-98` correctly returns 503 when
  `deps.metrics` is undefined (tested at metrics.spec.ts:107-124) —
  good defensive shape for a separable capability.
- `assertProductionEnv` at
  `apps/api/src/config/required-env.ts:17-31` short-circuits on
  non-production and only polices the dev-localhost defaults. That's
  the right scope — it's an assertion, not a validator, and it
  doesn't need URL parsing.
- The `POST /internal/rollback-reported` callback is fail-open at
  `scripts/deploy/rollback.sh:41-43` with `|| log "(warning)…"` —
  the rollback itself is authoritative and the metric under-counts
  gracefully, exactly as the task doc's "DNA" line prescribes.
- Commit messages carry useful rationale, especially commit 241cfec's
  "BLOCKER-1/2" narrative which maps each fix to the review finding.

## Suggested follow-up TODOs

- **TODO(task-010-follow-1)**: fix the active-channel unread bump (finding
  #1). One-line change if you pick option (a); three lines if you wire
  activeChannelId properly.
- **TODO(task-010-follow-2)**: renumber task-010-E's
  `TODO(task-011..014)` markers to a free range (finding #2); update
  the four in-code comments and the task-010.md doc.
- **TODO(task-010-follow-3)**: narrow the `/internal/metrics`
  allowlist from `172.` / `10.` to the observed docker bridge
  subnet, or switch to a shared-secret header (finding #4). Add a
  negative-path test that exercises a non-allowlisted
  `remoteAddress`.
- **TODO(task-010-follow-4)**: harden the WEB_URL dev-default check
  to cover `127.0.0.1`, trailing slash, and case-insensitive
  `LOCALHOST` (finding #7).
- **TODO(task-010-follow-5)**: add a `TemplateElement`-aware selector
  to the palette ESLint rule, or document the interpolation blind
  spot explicitly (finding #5).
- **TODO(task-010-follow-6)**: rewrite the mention E2E payload to
  carry the real `users: [memberId]` so the test's name matches what
  it actually covers (finding #3).

## Resolution (task-010 reviewer response — commit 4097786)

Fix commit landed on `feat/task-010-beta-polish` after the reviewer
returned. HIGH + MED fixed forward; LOW/NIT carried as
`TODO(task-010-follow-*)` markers in the follow-up list above.

| Finding                                         | Severity | Resolution                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Unread pill bumps on active channel          | HIGH     | **Fixed**: `ui-store.ts` gains `activeChannelId` + setter; `MessageColumn.tsx` writes on mount, clears on unmount (only when still active — tolerates fast re-mounts). `useRealtimeConnection.ts` wires `activeChannelId: () => useUI.getState().activeChannelId`. MessageColumn also optimistically zeroes the cached unread on channel change so the pill clears immediately rather than waiting 500ms + rtt. |
| 2. TODO(task-011..014) namespace collision      | MED      | **Fixed**: renumbered to 031 (invite rate-limit), 032 (CAS fidelity), 033 (transferOwnership serializable), 034 (soft-delete purge). Grep confirmed 031-034 are free (028-030 already claimed by task-005).                                                                                                                                                                                                     |
| 3. Mention E2E payload sends `everyone: true`   | LOW      | **Deferred** → TODO(task-010-follow-6). Backend integration test covers the real user-mention branch via jsonb containment.                                                                                                                                                                                                                                                                                     |
| 4. /internal/metrics allowlist too wide         | LOW      | **Deferred** → TODO(task-010-follow-3). Narrowing to specific docker bridge is NAS-brittle; preferred fix is shared-secret header.                                                                                                                                                                                                                                                                              |
| 5. ESLint rule misses interpolated classes      | LOW      | **Deferred** → TODO(task-010-follow-5). Tailwind JIT doesn't see interpolated classes either; impact is nil.                                                                                                                                                                                                                                                                                                    |
| 6. transferOwnership note lacks review anchor   | NIT      | **Acknowledged** — task-010.md can be updated in a subsequent revision.                                                                                                                                                                                                                                                                                                                                         |
| 7. WEB_URL exact-string check                   | NIT      | **Deferred** → TODO(task-010-follow-4).                                                                                                                                                                                                                                                                                                                                                                         |
| 8. test:int / test:e2e not executed             | NIT      | **Accepted as AC gap** — disclosed in PR body; CI blocks on full-stack run.                                                                                                                                                                                                                                                                                                                                     |
| 9. 009 reviewer artefact plausibility           | NIT+     | **Noted (positive)** — no action.                                                                                                                                                                                                                                                                                                                                                                               |
| 10. Misleading comment at useRealtimeConnection | NIT      | **Fixed** (as part of #1) — comment replaced with an accurate one describing the store-backed activeChannelId wiring.                                                                                                                                                                                                                                                                                           |
