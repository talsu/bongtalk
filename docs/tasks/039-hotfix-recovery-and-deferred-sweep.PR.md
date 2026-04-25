## Summary

038 shipped 11 prod hot-fixes without task contracts (`928503c → de6032a`). 039 retroactively backs them with regression specs and closes two of the leftover 038-deferred items. No hot-fix code was touched (per the contract); only specs were added. Alertmanager is OUT — moves to task 040.

## Hot-fix → spec mapping

| Commit    | Area                            | Regression spec                                                      |
| --------- | ------------------------------- | -------------------------------------------------------------------- |
| `fb7f3fb` | DM message + WS fanout          | `dm-workspaceless-message.int.spec.ts` + `dm-realtime-fanout.e2e.ts` |
| `a425a3c` | DM URL decouple + inline column | `dm-workspaceless-flow.e2e.ts`                                       |
| `e678195` | participant name not "unknown"  | `dm-participant-name.int.spec.ts`                                    |
| `c5146ff` | useMessageHistory enabled gate  | `dm-workspaceless-message.int.spec.ts` (round-trip)                  |
| `712e199` | `/me/dms/:ch/messages` route    | `dm-workspaceless-message.int.spec.ts` (POST + GET)                  |
| `58a785c` | mobile DM workspaceless         | `dm-workspaceless-flow.e2e.ts` (375x667)                             |
| `bebfd20` | create dialog DS Dialog         | `workspace-create-dialog.e2e.ts` (open + dialog role)                |
| `538bbda` | field order                     | `workspace-create-dialog.e2e.ts` (boundingBox y order)               |
| `76ce9cc` | discover 3-column               | `discover-three-column-layout.e2e.ts`                                |
| `d72b606` | zero-workspace → /dm            | `zero-workspace-landing.e2e.ts`                                      |
| `1a2c321` | brand-mark fold                 | `home-dm-brand-mark-fold.e2e.ts`                                     |

## Chunks

### A — DM workspaceless regression specs

- `apps/api/test/int/dms/helpers.ts` — testcontainer postgres + redis, signup + makeFriends helpers (Global DM requires accepted friendship per task-033).
- `dm-workspaceless-message.int.spec.ts` (4 tests) — verifies `Channel.workspaceId` IS NULL for the created DM, send + history round-trip, non-participant gets 403/404, idempotency-key replays the same row with `Idempotency-Replayed: true`.
- `dm-participant-name.int.spec.ts` (3 tests) — list rows always carry the other side's username; Alice/Bob symmetry; the whole list never contains "unknown" / null / empty.
- `dm-workspaceless-flow.e2e.ts` — desktop + mobile (375x667) round-trip; reload preserves history; URL never contains `/w/`.
- `dm-realtime-fanout.e2e.ts` — two browser contexts; A→B and B→A messages fan out via WS room.

### B — Workspace UX regression specs

- `workspace-create-dialog.e2e.ts` — "+" rail button opens a `role=dialog` overlay (URL unchanged); name/slug/description/visibility/category vertical order asserted via `boundingBox().y` chain; public-without-category submit blocks; private-without-category creates the workspace.
- `discover-three-column-layout.e2e.ts` — desktop has `workspace-nav | discover-side | discover-page` with x-axis ordering, "워크스페이스 찾기" row carries `aria-current=page`; mobile collapses (no rail/aside testids).
- `zero-workspace-landing.e2e.ts` — fresh signup lands on `/dm` (never `/w/new`); `ws-nav-dm` testid is **absent**; rail still has `+`, compass, brand-mark.
- `home-dm-brand-mark-fold.e2e.ts` — brand-mark click navigates to `/dm`, `aria-label="메세지"`, separate DM icon does not exist.

### C — orphan-gc list-objects-v2 pagination

- `attachment-orphan-gc.sh` — replaced single `list-objects-v2` call with a `--continuation-token` loop. Page parsing uses python3 (already a backup-container dep); empty `NextContinuationToken` ends the loop. The single-page case still works (no token → returned, loop exits after one iteration).
- `scripts/backup/test/orphan-gc-pagination.test.sh` — uploads 1500 emoji-shaped keys to a unique fixture prefix `__pagination-test-<stamp>__/...` inside the live `qufox-attachments` bucket, runs the script in dry-run, asserts `scanned >= 1500`, cleans up via `s3 rm --recursive` in a trap. Re-uses live bucket because qufox-api creds can't create new buckets; the prefix sentinel keeps fixture data isolated from real workspace UUIDs.

### D — INVALID_MAGIC_BYTES 400 → 422

- `error-code.enum.ts:152` — `[ErrorCode.INVALID_MAGIC_BYTES]: 400` → 422.
- `error-code.spec.ts` — adds an explicit `expect(...).toBe(422)` so a future "tighten everything to 400" sweep can't silently regress.
- No client-side handler depends on the 400 code (grep across `apps/web/src` for `INVALID_MAGIC_BYTES` returns 0 hits — the client uses `errorCode` from the body, not status).

## Testing

- API unit + service: 83 tests green (was 82; +1 from the new error-code mapping assertion).
- Int (testcontainer): 7 new dm tests green.
- Web unit: 38 unchanged.
- New e2e specs: scaffolded, will run in CI / local Playwright run (no local dev server in this environment).
- DS diff `git diff e6ee320..HEAD -- apps/web/public/design-system/`: empty.

## Out of scope

- Alertmanager wiring → task 040.
- Hot-fix code itself (touch-free per contract).
- orphan-gc additional prefix coverage.
- 422 propagation to a custom error type on the client.

## Branches

`feat/task-039-hotfix-recovery` retained per memory.
