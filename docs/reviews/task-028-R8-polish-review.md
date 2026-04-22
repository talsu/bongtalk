# task-028 R8 Polish Review — DMs + Activity (commit e2a6b61)

Adversarial re-read of the R8 fixes on `feat/task-028-polish-loop-3-dms-activity`.

## BLOCKER

None.

## HIGH

None. The `directs` CTE join condition (`Channel.type='DIRECT'` + `Channel.deletedAt IS NULL` + USER-level `ChannelPermissionOverride` with `principalId = ${userId}` and `allowMask & 1 > 0`) is bit-identical to the gate used in `direct-messages.service.ts:125-129` for the caller's own DM list. A non-participant cannot satisfy this join (no USER-override row for them), so the UNION cannot leak DMs. `Channel.workspaceId` is projected from the Channel row itself, so cross-workspace bleed is also impossible.

## MEDIUM

1. `directs` / `unread_directs` CTEs bypass the `acc` CTE and hit `Channel` + `ChannelPermissionOverride` directly. Functionally correct (USER-override is the sole membership signal for DMs), but diverges from the pattern used for mentions/replies/reactions. Consider a brief comment near the CTE explaining why `acc` is not needed; otherwise a future contributor may "fix" it by adding an `acc` join and accidentally require `WorkspaceMember.role` metadata that does not drive DM ACL.

2. `includeDirect` is gated at **WHERE-level**, not CTE-level (same as peers). Postgres short-circuits cheaply when `${includeDirect} = false`, so no real cost — but the raw-SQL pattern is wasteful for future filters. Non-blocking; matches existing code style.

## LOW

1. `MobileActivity.tsx` doc-comment still says "qf-m-segment (4 filters)"; the segment now renders 5 (`all/mentions/replies/reactions/directs`). `qf-m-segment` uses `grid-auto-columns: 1fr` so layout survives, but the comment is stale. Trivial.

2. Candidate self-filter `m.userId !== user?.id`: if `useAuth()` transiently returns `user === null`, the filter is a no-op (everyone passes). Routes are auth-gated and the server-side `DmService.createOrGet` rejects self-pair anyway (defense in depth), so safe. Optional tightening: render a loading stub while `user` is null.

3. No test explicitly enumerates `ActivityFilter` values (only `activity-filters.e2e.ts` and `activity-screen.e2e.ts` click specific tabs). Adding a `directs` click would prevent regressions where the new tab silently breaks.

4. `activity-filters.e2e.ts` was not updated to cover the `directs` tab in R8. Not a gate, but R8's own spec coverage for the new tab is zero.

## Verdict

**PASS** — merge to develop.

Gate correctness is solid, types propagate end-to-end (`ActivityKind`/`UnreadCounts`/controller `Filter`), UI additions are additive and do not change DS mobile.css. MEDIUM-1 and LOW-1..4 are follow-ups, not blockers.
