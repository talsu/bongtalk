# Reviewer — task-034 home-restructure-deferred-sweep

Branch `feat/task-034-home-restructure-deferred-sweep` tip `e293f6f` on
top of merged task-033 (`6ce35cd`). Scope covers chunks A + I + J: widen
`Channel.workspaceId` to nullable, cascade through ACL / attachments /
reactions / S3 key builder / controller shape, plus friend-gated Global
DM now creates a truly workspaceless DIRECT row. Chunks E / F (mobile
Home split + overlay slide) explicitly deferred.

Verdict: **Approve with one HIGH fix-forward and two noted-but-OK
concerns.** The backend foundation is sound, the prod-audit-before-
migration is properly documented, and the guard cascade is internally
consistent. One real race regression needs patching before real traffic.

## HIGH — idempotency race in `createOrGetWorkspaceless`

`Channel.@@unique([workspaceId, name])` with the column nullable is a
regression. PostgreSQL treats NULL as distinct in unique indexes by
default, so two concurrent `POST /me/dms` calls for the same pair can
both pass the `findFirst` probe, both INSERT, and neither hit P2002 —
the catch block is dead for the workspaceless branch. The old
workspace-scoped path relied on the constraint firing; the new path
does not. Fix forward: add a partial unique index in a follow-up
migration, e.g. `CREATE UNIQUE INDEX "Channel_global_dm_name_uniq" ON
"Channel"(name) WHERE "workspaceId" IS NULL AND type = 'DIRECT' AND
"deletedAt" IS NULL;` (Prisma has no `@@unique(... where: ...)` so raw
SQL as in the mentions/outbox-partial precedents). Until then,
concurrent Global-DM creation from the same user pair will duplicate
channels with divergent override rows.

## NOTED — CHECK constraint is OR, not XOR

Migration constraint is `(type='DIRECT') OR ("workspaceId" IS NOT
NULL)`, which _permits_ a DIRECT row with a non-null workspaceId. The
schema-comment claims XOR. This is intentional back-compat with
task-027 workspace-scoped DMs (the `createOrGet` path still writes
them) and is the right call — tightening to XOR would break any
existing 027 DM row. Action: update the schema comment to match the
migration (say "OR", or "DIRECT may be workspaceless; every non-DIRECT
MUST have a workspace") to avoid future confusion.

## NOTED — `__dm__` S3 prefix collision

Not a real risk: `buildKey` uses `workspaceId` which is a UUID, never
the literal string `__dm__`. Workspace _slugs_ are human-readable but
they don't appear in the key. Clean.

## OK

- `ChannelAccessService.resolveEffective` DIRECT short-circuit is
  correct: DIRECT channels skip the workspace-member gate and fall
  back to override-only ACL, matching the DM permission model
  established in 027.
- `channels.service.list` still filters `type != DIRECT`, so DIRECT
  rows stay out of the workspace sidebar even with nullable
  workspaceId.
- E2E `dm-global-workspaceless.e2e.ts` proves the happy path (two
  strangers → friends → DM) but does not exercise the concurrency
  race above — acceptable for now, add when the partial-unique
  follow-up lands.
- Chunks E/F deferral is appropriate; scope stayed coherent.

## Required follow-up

`TODO(task-034-follow-partial-unique)` — ship the partial unique index
on `(name) WHERE workspaceId IS NULL AND type='DIRECT' AND deletedAt
IS NULL` plus a concurrency E2E before Global DM goes to real users.
Fix-forward on develop; does not block this merge.
