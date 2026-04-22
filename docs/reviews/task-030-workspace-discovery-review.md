# Reviewer — task-030 Workspace Discovery

Branch: `feat/task-030-workspace-discovery` @ `e54b12c`
Commits: docs / feat(api A..C) / feat(web D..F) / test(e2e H)

## Verdict

**FIX-FORWARD required.** Two BLOCKERs and three HIGHs against the
mechanical acceptance criteria. MED/LOW can defer as follow-ups.

---

## BLOCKER

### B1. ADMIN can flip workspace to PUBLIC

Contract C (line 88): _"OWNER 만; ADMIN 거부"_. Actual:
`WorkspacesController.update` is annotated `@Roles('ADMIN')`
(controller L83), and `WorkspaceRoleGuard` treats `@Roles` as _minimum_
rank — ADMIN and OWNER both pass. `service.update()` does not
re-check.

An ADMIN today can `PATCH /workspaces/:id { visibility: 'PUBLIC',
category, description }` and expose a workspace to Discovery
without the OWNER's consent. This is the privacy case the contract
Risks section calls out.

**Fix**: promote the decorator to `@Roles('OWNER')` on the PATCH
route (or split a `/visibility` sub-route if other update fields
should stay ADMIN-writable). Add int/e2e negative case — ADMIN PATCH
visibility → 403 WORKSPACE_INSUFFICIENT_ROLE.

### B2. Chunk G (Workspace settings UI for visibility toggle) not implemented

Contract Scope (IN) G + `workspace-visibility-toggle.e2e.ts` name is
reused for an API-only test. No `WorkspaceSettings` React tree, no
OWNER/ADMIN role gating in UI, no "기존 멤버 유지" toast. DoD line 170
requires the E2E to assert: OWNER toggle OK, ADMIN toggle 거부, 카테고리
공란 시 저장 실패. The shipped spec only covers the first and third
via HTTP — ADMIN-deny is silently skipped (and would fail today —
see B1).

---

## HIGH

### H1. Integration specs missing

Acceptance (line 223) lists 3 int specs (`discovery-list.int.spec.ts`,
`workspace-join.int.spec.ts`, `visibility-toggle.int.spec.ts`). None
exist. E2E specs partially substitute but do not cover the cursor
pagination / sort order / rate-limit surfaces the contract explicitly
names.

### H2. Rate limits not wired

Contract C: POST /workspaces/:id/join = 5/min/user;
PATCH visibility = 10/hour/workspace. Neither endpoint has
`@Throttle`, Redis token-bucket, or equivalent. Without these, the
abuse-vector mitigation the contract cites is absent.

### H3. Eval harness missing

Acceptance (line 241): `evals/tasks/041-workspace-discovery.yaml`.
`evals/tasks/` has no 041 file. `pnpm eval` success gate is therefore
not auditable for this task.

---

## MED

### M1. Discover `q` only matches name, not description

Service L176: `w.name ILIKE '%' || q || '%'`. Contract C: "q 는
name + description substring". Fix by OR-joining `w.description
ILIKE` to the WHERE (index is on visibility+category; ILIKE stays a
seq scan either way at beta scale).

### M2. Discover sort tie-break is `w.id`, not `last_activity_at`

Service L186: `ORDER BY COUNT(wm.*) DESC, w.id DESC`. Contract C:
`(member_count DESC, last_activity_at DESC)`. The SELECT computes
`lastActivityAt` but the ORDER BY drops it. Cursor encodes
`memberCount|id`, which would also need to change to encode
`memberCount|lastActivityAt|id` for a stable activity-sorted pager.

### M3. `/discover` page gated behind auth

`App.tsx` wraps `ProtectedDiscoverRoute` with `status === 'anonymous'
→ /login`. Contract Design Decision (line 299) and D bullet explicitly
require anonymous browse + redirect-only-on-Join. Today anon hits
`/discover` → forced to `/login` before they see any list.

### M4. Server-rail order does not match contract

Contract Acceptance (line 234): `+ → 찾기 → DMs`. Actual
`WorkspaceNav.tsx` order: workspaces → divider → **찾기 → +**, and
no DMs link on the rail at all. User's own message flags this as
"compass 찾기 button between divider and +" — so the deviation is
intentional, but the Acceptance Criteria checkbox is unmet without
a contract amendment. Either update the contract or reorder the
buttons. No e2e asserts DOM order regardless.

---

## LOW

- **L1. `togglePublic(false)` clears category but not description.**
  Private create can carry a leaked description string. Not a security
  issue (nullable column) but surprises QA.
- **L2. Hidden description field uses `register('description')`
  alongside the live textarea on toggle.** Only one renders at a time,
  so no RHF collision — safe, but the comment-only justification is
  fragile; a single `<input type="hidden">` without the hidden wrapper
  div would be less clever.
- **L3. WORKSPACE_CATEGORY_META reuses `compass` for 3 categories.**
  GAMING/SCIENCE/TECH all render the same chip icon. Not a blocker —
  contract accepts substitutes — but uniquify before beta launch.
- **L4. `Icon name={icon as never}` cast in `DiscoverPage`
  CategoryChip** defeats the `IconName` type. Replace with a typed
  union on `WORKSPACE_CATEGORY_META[x].icon`.
- **L5. MobileDiscover tabbar has no `active` prop** — no tab
  selected on /discover. Cosmetic.
- **L6. No FINAL REPORT artefact yet** (`030-*.PR.md`) — create before
  merge per DoD (line 239).

---

## Clean / Good

- Prisma migration is metadata-only ALTER with default PRIVATE;
  reversible, no row rewrite at scale.
- `discover` raw SQL uses Prisma tagged templates (`${cat}::text`)
  → parameterised, injection-safe.
- Cursor null-guard (`cursorParts === null ? null : ...`)
  interpolates NULL correctly so the HAVING fallback works on page 1.
- `joinPublic` service-layer guards: deletedAt check + visibility
  check + membership check, idempotent result shape `{ alreadyMember }`.
- Route order `/workspaces/discover` before `/workspaces/:id` is
  correct — NestJS route resolver prefers literal over param.
- `WORKSPACE_NOT_PUBLIC` present in both `ErrorCode` enum + HTTP map
  (403) + `ErrorCodeSchema` shared-types (L72). No drift.
- CreateWorkspacePage 3 new fields (visibility / category /
  description) render with correct data-testids; `create-public.e2e.ts`
  asserts PRIVATE→PUBLIC toggle reveal.
- DS files (tokens / components / mobile / icons css+svg) untouched —
  design-system source-of-truth respected.

---

## Recommended fix-forward sequence

1. (B1) Flip PATCH to `@Roles('OWNER')` + ADMIN-deny int/e2e.
2. (B2) Ship Settings UI or explicitly amend contract to defer G →
   `TODO(task-030-follow-settings-ui)`.
3. (H1/H3) Add 3 int specs + 041 eval yaml.
4. (H2) Wire `@Throttle(5, 60)` on join, `@Throttle(10, 3600)` on
   PATCH (Redis-backed per WORKSPACE_SOFT_DELETE style).
5. (M1/M2) Extend ILIKE + reorder by `lastActivityAt`; update cursor
   format.
6. (M3) Either drop the auth gate on `/discover` (requires optional
   JWT + contract unchanged) or amend contract.
7. (M4) Reorder WorkspaceNav buttons + add DOM-order e2e assertion.

Token usage: approx 6.2k tool-output tokens across reads.
