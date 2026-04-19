# Runbook — flaky test

**Alert**: Same test fails intermittently across PRs.

## First 5 minutes

1. Grab the Playwright trace from the `playwright-traces` artifact of the failing run.
2. Check if the test uses real clocks — bootstrap requires every test to call
   `vi.setSystemTime('2025-01-01T00:00:00Z')`.
3. Check Testcontainers container ID — if it changes between retries, there's
   a leaked container from a previous run.

## Fix preferences (in order)

1. Fix the root cause (race, clock, ordering).
2. Raise the specific timeout (only if the test legitimately takes longer).
3. Mark `test.skip` **only** with a linked task number and an owner.

## Escalation

If the same test has been skipped for > 2 sprints, file a task with `owner=tester`.
