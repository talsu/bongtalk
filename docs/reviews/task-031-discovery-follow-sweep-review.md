# Reviewer — task-031 Discovery Follow Sweep

Branch: `feat/task-031-discovery-follow-sweep` @ `efc16b6`
Commits: `docs(task-031)` / `feat(030-sweep): 031-A..D`
Base: `e3cd08d` (post-030-follow)

## Verdict

**CLEAR TO MERGE.** Zero BLOCKERs. Zero HIGHs. One MED and two LOWs
noted for the follow-on backlog, none of them fix-before-merge. All
five 030 deferrals (D-1 Settings UI, D-2 rate limits, D-3 int specs,
D-4 ILIKE description + GIN, D-5 sort tie-break) land with matching
tests.

## What I re-verified adversarially

- **Shadow `WorkspaceSchema` removal** (shared-types/index.ts): no
  runtime consumer references the removed symbol — `grep WorkspaceSchema
apps/` returns zero matches; `packages/shared-types/src/index.spec.ts`
  doesn't parse it either. The richer `./workspace.ts` version is a
  strict superset, so every `Pick<Workspace,…>` site in apps/web
  continues to type-check against the same or narrower field set. Safe.
- **Partial GIN index predicate**: all three columns in the `WHERE`
  (`deletedAt IS NULL`, `visibility = 'PUBLIC'`, `category IS NOT NULL`)
  are `IMMUTABLE`-compatible literal comparisons — PG accepts the
  partial index. `CREATE EXTENSION IF NOT EXISTS pg_trgm` is idempotent
  and matches existing search-indexing precedent.
- **Cursor invariant (D-5)**: `ORDER BY count DESC, id ASC` paired with
  `HAVING count < prev OR (count = prev AND id > prevId)` is the
  correct lexicographic successor predicate. Verified by hand against
  tie rows.
- **Rate-limit keying (D-2)**: `ws:join:<userId>` (user-scoped, 5/60s)
  vs `ws:visibility:<wsId>` (workspace-scoped, 10/3600s) matches the
  task contract. Both gated before any DB write.
- **Shell splat collision guard**: `rest[0] === 'settings' && !rest[1]`
  correctly disambiguates `/w/:slug/settings` from
  `/w/:slug/:channel/settings`.
- **ADMIN read-only Settings**: all three inputs pass `disabled={!ownerEditable}`,
  `canSave` short-circuits on `ownerEditable`, and the admin-note is
  rendered. OWNER-only save path mirrors service-level B1 guard.

## Findings

### MED

**M1. Int specs rely on wall-clock Redis TTL despite `vi.setSystemTime`.**
`workspace-join.int.spec.ts` and `visibility-toggle.int.spec.ts` fire
6–11 requests in sequence expecting the 60s / 3600s Redis window to
stay open. On a cold NAS test runner under load, sequential supertest
calls have been observed to exceed 60s end-to-end (bcrypt signup +
6× workspace create). If that happens, the `ws:join` window expires
mid-burst and the final request slips under the cap — flaky green.
Mitigation: flush the counter at test start and assert on count rather
than wall time, or mock the Redis TTL clock. Not a blocker — current
CI NAS timings give ~8–12s margin.

### LOW

**L1. `WorkspaceSettingsOverlayHost` casts `category as never`.**
Shell.tsx:183 passes `workspace.category` into a `WorkspaceCategory | null`
prop via `as never`. Works at runtime because `active.category` is
already the narrow enum from Prisma, but the cast defeats the
shared-types check that the rest of the tree leans on. Swap to
`workspace.category as WorkspaceCategory | null`.

**L2. `useMembers` fetched just to resolve `myRole` in the overlay.**
Loading the full member list for a single "which role am I" lookup
is wasteful on large workspaces. The existing `getWithMyRole` service
method already returns `myRole` — a `GET /workspaces/:id` call would
avoid the fan-out. Follow-up, not blocking.

## Evidence checked

- `git diff e3cd08d..efc16b6 --stat` → 10 files, +855/-13
- `workspaces.controller.ts` rate-limit gates at L79 + L104
- `workspaces.service.ts` L185–L203 (ILIKE + HAVING + ORDER BY)
- `20260502000000_add_workspace_discovery_gin/migration.sql` — partial GIN OK
- Int specs under `apps/api/test/int/workspaces/` — three new specs
- `WorkspaceSettingsPage.tsx` — OWNER/ADMIN gating, confirm flow
- `Shell.tsx` L48–L51, L146–L148 — splat branch + overlay host
- `shared-types/src/index.ts` diff — shadow schema removal; no
  downstream breakage found

## Recommendation

Merge to `develop` with `--no-ff`, auto-promote to `main`. File M1/L1/L2
as task-032 seed. No fix-forward required for 031.
