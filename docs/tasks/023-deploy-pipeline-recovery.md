# Task 023 — Deploy Pipeline Recovery: webhook auto-deploy 재가동 + heartbeat guard → main deploy

## Context

`.deploy/audit.jsonl`'s last entry is a **2026-04-20T10:17Z webhook
git-fetch failure**. Since then, Task 021 and Task 022 both landed
on main via a manual CI → registry → pull fallback rather than the
real webhook pipeline. This means the
`feedback_auto_promote_to_main` safety net (`/readyz` gate +
auto-rollback on failure) has been **silently offline for three
days**. Every subsequent task has deployed through a secondary
path that is lightly tested and lacks the rollback logic.

023 diagnoses what broke, fixes forward, adds a heartbeat guard so
this kind of silent decay can't go 72 hours unnoticed again, and
— critically — is the first task since 2026-04-20 to flow through
the **real** webhook pipeline end-to-end.

## Scope (IN)

### A. Diagnosis

Collect evidence before making changes. Record findings in
`docs/tasks/023-*.PR.md` body.

- `docker logs qufox-webhook --tail 500` — what was the last
  activity? Any HMAC / signature / fetch / auth errors after
  2026-04-20T10:17Z?
- `docker ps | grep qufox` — is the webhook container still Up?
  How long?
- `docker exec qufox-webhook sh -c 'cd /repo && git status && git log --oneline -3 && git remote -v'`
  — clone state: correct branch? detached? last known good sha?
  remote URL correct?
- `docker exec qufox-webhook sh -c 'cd /repo && git fetch origin 2>&1 | head -20'`
  — can the container actually fetch? SSH deploy key still valid?
- GitHub → Settings → Webhooks → Recent Deliveries — delivery
  success / failure pattern since 2026-04-20. Response code from
  qufox.com/hooks/github?
- `curl -I https://qufox.com/hooks/github` — does nginx route
  the path? 401 / 404 / 5xx?
- `.env.deploy` GITHUB_WEBHOOK_SECRET exists? Matches what's
  registered in GitHub's webhook UI?
- `ls -la /volume2/dockers/qufox/.deploy/audit.jsonl` — file
  exists, writable by the container user, last-modified time?
- `ls -la /volume2/dockers/qufox-deploy/` — 017-B clone
  layout intact? HEAD detached? Uncommitted changes from manual
  fallback deploys?
- `tail -20 /volume2/dockers/qufox/.deploy/audit.jsonl` —
  exact content of the failure entry; is it a single message or
  a pattern?

Output: a ranked list of root cause hypotheses (likelihood +
evidence + fix plan).

### B. Fix forward

Apply the fix for the confirmed root cause. Expected candidates
(not exhaustive):

- **Deploy SSH key broken**: regenerate + re-register in GitHub
  → restart webhook container
- **Clone HEAD corrupt or diverged** in `/volume2/dockers/qufox-deploy`:
  `git fetch origin && git reset --hard origin/main`, verify
  HEAD matches remote
- **HMAC secret mismatch**: reset `GITHUB_WEBHOOK_SECRET` in
  `.env.deploy` to match GitHub's current value (or rotate both)
  → restart webhook
- **Nginx routing for `/hooks/github`**: diff
  `/volume2/dockers/nginx/nginx.conf` against 011's
  `runbook-nginx-diff.md` expected block
- **Webhook container needs rebuild**: pull latest image +
  recreate
- **audit.jsonl write permission broken**: `chown / chmod` on
  `/volume2/dockers/qufox/.deploy/`
- **Combined**: more than one of the above

If the fix requires user intervention (GitHub UI, Synology
DSM, external DNS), **stop and surface** with the exact action
needed. Don't guess.

### C. Smoke test (live E2E of the recovered path)

Once B lands, push an empty commit to main and verify end-to-end:

1. `git commit --allow-empty -m "ci: webhook smoke post-task-023"`
   on main + push
2. GitHub Settings → Webhooks → Recent Deliveries — confirm 2xx
   response from qufox.com/hooks/github within ~10 s
3. `docker logs qufox-webhook --tail 100` — confirm job received
   - auto-deploy.sh invoked
4. `tail -1 /volume2/dockers/qufox/.deploy/audit.jsonl` — new
   entry with sha matching the empty commit and `exitCode=0`
5. `curl -sk https://qufox.com/api/readyz` → 200
6. idle-window: sample `/readyz` 6× over 30 s, all 200
7. If the smoke fails: go back to A with the new evidence;
   Max 3 consecutive smoke attempts. If all three fail, halt and
   report to user with full diagnostic bundle.

### D. Heartbeat regression guard

A silent 72-hour failure means we need an active signal:

- New script `scripts/deploy/tests/webhook-heartbeat.sh`:
  - Reads `.deploy/audit.jsonl` mtime and compares to now.
  - Exits 0 if mtime is within the threshold (default 24 h,
    env-overridable).
  - Exits 1 with a clear message otherwise.
- Hook into the existing `qufox-backup` cron container (011's
  cron scheduler) OR a new minimal alpine `qufox-heartbeat`
  cron container (implementer picks cheaper option).
- On failure, the script writes to a location the operator
  will notice:
  - Sends to Slack webhook if `SLACK_WEBHOOK_URL` is set in
    `.env.deploy` (011 already reads this)
  - Otherwise appends a line to
    `/volume2/dockers/qufox/.deploy/heartbeat-alerts.log`
- Integration spec / unit test: drive the script with a
  known-mtime fixture file and assert exit code.

### E. Main auto-promotion + deploy verify (**real webhook path**)

After A–D land on develop:

1. develop merge per standard flow
2. `git checkout main && git pull --ff-only`
3. `git merge --no-ff develop -m "Deploy task-023 to prod: webhook pipeline recovery + heartbeat"`
4. `git push origin main`
5. Wait 1–3 min for **the webhook pipeline** (not the fallback)
   to run
6. Verify:
   - `.deploy/audit.jsonl` last entry: `exitCode=0`, sha matches
     main tip
   - `/readyz` 200
   - idle-window 30 s all 200
   - **This is the first task since 2026-04-20T10:17Z deployed via
     the real webhook.** FINAL REPORT must call this out.

### F. Auto-forward FINAL REPORT to pane 1

Per the new memory `feedback_pane0_auto_forward_report.md`:

1. Print FINAL REPORT to pane 0 terminal (as before)
2. Build a one-line summary (see memory for fields + size
   constraint)
3. `printf '%s' '<summary>' > /tmp/task-023-pane1-handoff.txt`
4. `tmux load-buffer /tmp/task-023-pane1-handoff.txt`
5. `tmux paste-buffer -t 7:0.1 -d`
6. `sleep 1 && tmux send-keys -t 7:0.1 Enter`
7. If paste fails, print `[WARN] pane 1 자동 전달 실패: <reason>`
   in pane 0

This is the first task with auto-forward, so document the
mechanism in the PR body too (so future tasks can copy the
pattern even if the memory is absent).

## Scope (OUT)

- Webhook HA / multi-replica — big re-architecture, separate task
- audit.jsonl gap backfill for 2026-04-20 → 2026-04-22 — no
  authoritative source; document as known gap only
- Replacing the webhook with a different trigger (GitHub Action
  runner, polling, etc.) — different design decision
- New product features

## Acceptance Criteria (mechanical)

- Diagnosis section present in `docs/tasks/023-*.PR.md` with
  root cause + evidence references.
- `docker exec qufox-webhook sh -c 'cd /repo && git fetch origin'`
  succeeds.
- `.deploy/audit.jsonl` has a new `exitCode=0` entry for the
  task-023 main commit.
- `curl -sk https://qufox.com/api/readyz` 200 post-deploy.
- `scripts/deploy/tests/webhook-heartbeat.sh` exists, executable,
  exits 0 with a fresh audit.jsonl, exits 1 with a stale fixture.
- Heartbeat cron scheduled (inside qufox-backup or new container);
  `docker ps` shows it running.
- `pnpm verify` green.
- Three artefacts: `023-*.md`, `023-*.PR.md`, `023-*.review.md`.
- Reviewer subagent actually spawned + token count recorded.
- Direct develop merge.
- **main auto-promoted via the real webhook pipeline**, not the
  fallback path.
- Feature branch retained.
- **Pane 1 auto-forward** — pane 1 receives the summary line
  without the user relaying it.

## Prerequisite outcomes

- 022 merged + deployed to main (`04e45ac`), but via fallback
  path.
- 017-B clone layout still in place at
  `/volume2/dockers/qufox-deploy`.
- `feedback_pane0_auto_forward_report.md` memory exists (added in
  INIT step of this task).
- pane 1 Claude Code session open and at its prompt ready to
  accept paste input on `7:0.1`.

## Design Decisions

### Diagnosis before fix

Blind re-registering the SSH key or restarting the webhook would
fix something eventually but leaves no record of the actual
cause. The pattern "find, document, fix, verify, guard" produces
a task report that makes the next regression easier to diagnose.

### Heartbeat threshold 24h

The `.deploy/audit.jsonl` mtime is a weak signal (updated on
every deploy, not on every health tick), but 24h is generous
enough that a quiet weekend won't alert, yet tight enough that
a 72h silent decay like this one would have caught.

### Smoke test is an empty commit

Empty commits don't cause real code changes, so the rollout is
a no-op for api + web but exercises every gate. Fastest and
cheapest E2E.

### Pane 1 auto-forward uses tmux paste-buffer

Same mechanism pane 1 has been using to push handoffs to pane 0
all along — inverted direction. No new infra, no Slack, no
message broker. The one-line summary is the contract; anything
bigger goes in the PR body.

### If user intervention is needed, stop

GitHub UI actions (deploy key rotation, webhook secret) can't be
scripted without extra auth setup. Better to pause and say
"please do X" than to hack a half-fix.

## Non-goals

- Changing how auto-deploy.sh works inside the container
- Replacing `scripts/deploy/*.sh` with a different deploy tool
- Adding full-fledged monitoring dashboards (heartbeat is the
  minimum signal)
- Migrating the webhook to a different port / domain

## Risks

- **Root cause might be on GitHub's side** (their webhook
  retries, their delivery queue). Evidence check in A step A1+A3
  should catch this. If confirmed, fix is "re-enable / re-deliver"
  from GitHub UI, possibly with user action.
- **Fix might not be durable** — if the root cause is environmental
  (disk full, network routing change), it can recur. Heartbeat
  guard catches recurrence within 24h; if it re-occurs within
  hours of this fix, escalate to architectural review.
- **Smoke empty commit triggers full rebuild** of api / web
  images in the clone path. If build hasn't run in days, first
  rebuild can take 3–5 min. Smoke wait budget should accommodate
  (use 5 min wait not 1–3 min).
- **Auto-forward to pane 1 might arrive when pane 1 is mid-thought**.
  The paste interrupts. Accept — pane 1 can queue / ignore / read
  context. Better than manual relay every time.
- **tmux pane target might be wrong** if windows got reshuffled.
  Use `tmux list-panes -a` first to confirm `7:0.1` still points
  at the design pane.

## Progress Log

_Implementer fills._

- [ ] UNDERSTAND (run diagnosis checklist A, collect evidence)
- [ ] PLAN approved (root cause hypothesis ranked, fix plan picked)
- [ ] SCAFFOLD (heartbeat script stub, test fixture, cron slot)
- [ ] IMPLEMENT (A → B → C → D)
- [ ] VERIFY (`pnpm verify` + smoke E2E real webhook path)
- [ ] OBSERVE (audit.jsonl exitCode=0, /readyz 200, idle-window
      30s, heartbeat cron running)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote **via real
      webhook** → FINAL REPORT printed + auto-forwarded to
      pane 1)
