# Task 017 Review — stabilization sweep

**Reviewer**: reviewer subagent (general-purpose)
**Branch**: feat/task-017-stabilization-sweep @ `51e16e3`
**Base**: develop @ `af72ca8`
**Transcript**: ~28k
**Verdict**: approve

Branch contains 14 commits (5 native to 017 + 9 brought in via the
`fa6b7ca` main-into-017 merge: 7 ops commits named in the contract +
2 empty trigger commits + 1 main merge commit `d1afea9`).

---

## A (016 closure) findings

### A-1 — E2E specs

- `apps/web/e2e/shell/onboarding-checklist.e2e.ts:24` — test 1
  asserts workspace create → `1 / 4`, channel create → `2 / 4`,
  invite → `3 / 4`, first message → card `toHaveCount(0)`,
  reload → still hidden.
- `apps/web/e2e/shell/onboarding-checklist.e2e.ts:99` — test 2
  covers the manual ✕ dismiss + reload-persistence branch. Reads
  `GET /me/onboarding-status` to prove the hide is driven by the
  dismiss click, not by completion (`invitesIssued=0`,
  `messagesSent=0` invariants asserted). Good hygiene.
- _NIT._ Test 1 cannot observe the 0/4 state on `/w/new` (the
  OnboardingCard only mounts inside the `/w/:slug` shell). The
  spec trade-off is explicitly documented in the preamble
  comment; the contract-worded "0→4" is effectively `1→4` here.
  Acceptable — a fresh account at `/w/new` has no card surface
  to observe 0/4 against.
- `apps/web/e2e/shell/feedback-widget.e2e.ts:27` — BottomBar 💬 →
  modal visible → `feedback-category=BUG` + content filled →
  submit → `getByText('피드백 감사합니다!')` visible + modal
  closed. Then 4 API submits stay 201 (total 5/hour) + 6th →
  429 `RATE_LIMITED`. Matches the contract's "5/hour" boundary
  exactly. 2000-char counter presence verified via
  `locator('text=/ 2000').toBeVisible()`.
- `apps/web/e2e/auth/beta-invite-required.e2e.ts:35` — gated via
  `test.beforeAll` that skips unless `BETA_INVITE_REQUIRED=true`,
  and test 2 additionally skips if `E2E_SEED_INVITE_CODE` is not
  set. Test 1 (line 44) asserts `POST /auth/signup` without
  `inviteCode` → 403 `BETA_INVITE_REQUIRED`. Test 2 (line 59)
  asserts seeded inviteCode → 201. The "invite usedCount
  unchanged" verification is deferred to the 016 int spec
  (`beta-invite-guard.int.spec.ts`) with a void-noop comment —
  this is the contract-sanctioned deferral.

### A-2 — LOW follow-ups

- `scripts/setup/init-env-deploy.sh:77` — heredoc includes
  `BETA_INVITE_REQUIRED=true` with a commented block (lines
  70–76) documenting that qufox-api reads it from `.env.prod`
  but surfacing it in `.env.deploy` aids operator-facing
  logging. Dry-run path (line 81) prints the full heredoc.
- `apps/api/src/feedback/feedback.controller.ts:62-73` —
  workspaceId membership check implemented via
  `prisma.workspaceMember.findUnique({workspaceId_userId})`.
  Non-null + non-member → `WORKSPACE_NOT_MEMBER`. Null
  workspaceId short-circuits (line 62 guard). Normalization of
  `workspaceId` to `null` when empty-string / undefined is at
  line 56 — sound.
- _MED_. Contract A-2 wording ("`403 WORKSPACE_NOT_MEMBER`")
  vs. implemented HTTP status (404). The existing
  `ERROR_CODE_HTTP_STATUS` mapping at
  `apps/api/src/common/errors/error-code.enum.ts:71`
  assigns `WORKSPACE_NOT_MEMBER` → 404, and the implementer
  reused it rather than adding a site-specific 403 variant. The
  int spec (`feedback-workspace-membership.int.spec.ts:66`)
  asserts 404 and the PR.md explicitly calls this out. The
  semantic intent (block non-member) is satisfied and changing
  a cross-cutting enum mapping for one controller site would
  be worse. **No action required**, but note: every other
  `WORKSPACE_NOT_MEMBER` site also returns 404, so contract
  prose is the outlier, not the code.
- `apps/api/test/int/feedback/feedback-workspace-membership.int.spec.ts`
  has three `it` blocks (lines 34, 52, 70): member-OK,
  non-member-404, null-OK. All three assertions match the
  three-branch contract.

---

## B (worktree) findings

- `scripts/setup/migrate-webhook-worktree.sh` present; mode
  `0700` (owner admin:users, exec bit set). Idempotent via
  three-state classification at lines 57-65 (absent /
  worktree / occupied). Occupied-state exit 4 with a
  human-readable pointer (lines 77-82).
- `--dry-run` branch (line 92) prints the plan without side
  effects — matches AC line 189.
- `compose.deploy.yml:55` bind-mount uses
  `${DEPLOY_WORKTREE:-/volume2/dockers/qufox-deploy}:/repo`.
  Operator can override via `.env.deploy`; default matches
  contract. Preamble comment (lines 43-54) documents the
  dependency on the one-shot migrate script.
- `docs/ops/runbook-webhook-debug.md:102-146` — new
  "Worktree layout (task-017-B)" section (~45 lines) covers:
  why the split, one-shot migration (dry-run → apply),
  verify triplet, recovery ("re-run migrate script"),
  dual-tree-on-same-branch workflow, and the `git worktree
repair` escape hatch for relocation. Matches all five
  bullets the contract specified.
- `scripts/deploy/auto-deploy.sh` — the B-chunk left this
  file unchanged with respect to `REPO_PATH` (contract said
  no changes expected). Confirmed by diff: the only
  auto-deploy.sh additions are the `safe.directory` config
  (pulled in from main via `f1883b8`) and the D-chunk
  `GIT_SSH_COMMAND` export (lines 31-37). `/repo` bind-mount
  abstraction holds.
- _NIT_. The migrate script's `sleep 3` (line 121) is a tiny
  timing gap — the verify step (line 123) would benefit from
  a retry loop (e.g. try every second for up to 15s). Not a
  blocker; a follow-up hardening candidate.

---

## C (main reconciliation) findings

- Merge commit `fa6b7ca` present on the branch.
  `git log --merges af72ca8..51e16e3` returns this commit +
  `d1afea9` (the "Deploy 011-016 to prod" merge that came in
  from main). Commit message starts with
  `Merge origin/main into feat/task-017 — 011-016 prod ops
fix-forward + worktree prep` — matches the contract's
  "Merge origin/main" phrasing.
- All 7 main-side SHAs verified as ancestors of `51e16e3` via
  `git merge-base --is-ancestor`:
  - `9e5b31c` ✓
  - `039d45c` ✓
  - `f1883b8` ✓
  - `fdd6fb2` ✓
  - `b4dbbf7` ✓
  - `41ee1c4` ✓
  - `d1afea9` ✓
- Merge commit message enumerates all 7 SHAs with short
  descriptions + notes the two empty-trigger smoke commits
  (`d15b908`, `f36bf6c`). Clean merge, no conflict markers
  in the working tree.
- Pre-merge state: `git log origin/develop..origin/main
--oneline | wc -l` = 9 (= 7 named + 2 triggers, all of
  which this branch already swallowed via `fa6b7ca`). Post
  017-merge-to-develop, this count drops to 0 — matches AC
  line 193–194 and the PR.md's post-merge verification
  block.

---

## D (ssh known_hosts) findings

- `services/webhook/Dockerfile:35-36` — build-time
  `ssh-keyscan -t ed25519,rsa github.com > /tmp/known_hosts-seed`
  with `chmod 0644`. Runtime-stage step, so the seed
  survives into the final image.
- `services/webhook/Dockerfile:51-52` — `CMD` wraps
  `cp /tmp/known_hosts-seed /tmp/known_hosts 2>/dev/null ||
true; exec node dist/main.js`. Idempotent at each boot,
  tolerates missing seed (never fails the container start).
- `scripts/deploy/auto-deploy.sh:37` —
  `export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/tmp/known_hosts
-o StrictHostKeyChecking=yes"`. Scoped to the deploy script
  process; the `StrictHostKeyChecking=yes` means the seed
  MUST exist and match, which is exactly the build-time
  contract. Good.
- _NIT_. `-o StrictHostKeyChecking=yes` with a pre-seeded
  hosts file means an unseeded container (e.g. someone
  starts the webhook image with a `--entrypoint` override
  that skips the CMD copy) would fail git-fetch. Acceptable
  — the only entry points into auto-deploy.sh run via the
  webhook CMD which does the copy. Document in runbook-deploy
  if anyone ever adds a non-CMD path.

---

## Cross-cutting / secrets scan

- **`any` type usage**: 0 new `\b any \b` or `as any` matches
  in the added business-code lines. One prose match in the
  int spec ("from any user") — not a type annotation.
- **Secret leaks**: `git log HEAD --all --name-only |
grep -E '^(\.env\.prod\.bak|.*\.zip)$'` returns **0 lines**.
  `.gitignore` (lines 46-55) captures `.env.prod.bak.*`,
  `*.zip`, `*.tar.gz`, `qufox-design.zip` explicitly. The
  "near-miss" amendment worked; no secret blobs in history.
- **Token/password scan on the diff**: the only matches are
  test fixtures (`const PW = 'Quanta-Beetle-Nebula-42!'` — a
  fixture already reused across 10 e2e specs) and test-scope
  token variables (`accessToken`, `seedInviteCode` read from
  `process.env`). Clean.
- **TODO regression**: `grep -rn 'TODO(task-016-follow-1\|
…|TODO(task-016-follow-7' --include='*.ts' --include='*.tsx'
--include='*.sh' .` returns **0 lines**. The only match
  when including `*.md` is the contract file itself (line 192),
  which is the specification of the check. Contract AC line 192
  satisfied.
- **`git log origin/develop..origin/main --oneline | wc -l`**:
  currently 9, will drop to 0 after 017 merges to develop.
  Noted in PR.md — this is the post-merge gate, not a
  pre-merge assertion.
- **Conventional commits**: all 5 native 017 commits use
  `feat:` / `fix:` / `docs:`. The merge commit
  (`fa6b7ca`) uses a "Merge origin/main into feat/task-017 — …"
  form which is standard for `git merge --no-ff` and matches
  git's own defaults. Pulled-from-main commits are already
  conventional (fix/ci); the `d1afea9 Deploy 011-016 to prod`
  commit is an older merge commit from main and was
  conventional at author time per its own commit. No new
  non-conventional commits introduced by 017 work.
- **`pnpm verify`**: PR.md cites 19/19 success, 0 errors.
  Not re-executed by this reviewer; accepted on PR.md
  evidence.
- **Docstring alignment**: all three new e2e specs, the int
  spec, the controller diff, the migrate script, the init-env
  diff, and the Dockerfile additions carry dense inline
  commentary explaining intent + the task-NNN it traces to.
  High quality, reads like production.

---

## Deferred to task-017-follow-\*

- **task-017-follow-1 (NIT, optional)**: retry loop around the
  migrate script's post-recreate `rev-parse --abbrev-ref HEAD`
  verify (replace fixed `sleep 3` with a 1-per-second poll
  up to 15s). Hardens against slow NAS container boots.
- **task-017-follow-2 (NIT, optional)**: add a runbook note
  to `docs/ops/runbook-deploy.md` warning that
  `GIT_SSH_COMMAND=… UserKnownHostsFile=/tmp/known_hosts
StrictHostKeyChecking=yes` requires the webhook CMD's seed
  copy to have run. If anyone adds a manual `docker exec
qufox-webhook bash` + re-invokes auto-deploy.sh, they need
  to `cp /tmp/known_hosts-seed /tmp/known_hosts` first.
- **task-017-follow-3 (MED, informational)**: contract A-2
  prose says "`403 WORKSPACE_NOT_MEMBER`" for `POST /feedback`
  but the global ErrorCode → status map assigns 404 to this
  code. Code + int spec are consistent at 404. Fix prose in
  a future contract revision or add a controller-scoped 403
  override (the latter is worse; prefer the former).

---

## Summary

All contract-specified deliverables are present and align with
the PR.md inventory. The three E2E specs carry sensible
trade-off documentation where Playwright's observable surface
differs from the contract phrasing (0/4 vs 1/4, toast vs DB
probe, invite-usedCount deferred to an existing int spec). The
two LOW follow-ups land as designed. The worktree migration
script is idempotent, three-state, dry-run-capable, and post-
verifies. The main→develop merge cleanly carries all 7 named
commits + the two trigger-smokes + main's merge commit, with
an annotated merge message. The ssh known_hosts cleanup is
both build-time-seeded and runtime-copied, and the deploy
script's GIT_SSH_COMMAND routes through tmpfs.

No BLOCKER, HIGH, or blocking-MED findings. The MED item about
the 403-vs-404 contract/code divergence is a prose-edit
candidate, not a code issue — the existing enum mapping is
correct and consistent.

**Verdict: approve.** Safe to merge direct into develop per
the `feedback_skip_pr_direct_merge.md` memory.
