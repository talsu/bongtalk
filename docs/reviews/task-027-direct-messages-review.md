# task-027 — Direct Messages — Reviewer Subagent

Branch: `feat/task-027-direct-messages` · 3 commits · adversarial re-read.

## BLOCKER

**B1. `ChannelAccessGuard` reads `req.member`, but nothing sets it.**
`apps/api/src/channels/guards/channel-access.guard.ts:71` does
`const member = (req as { member?: { role: string } }).member;`.
`WorkspaceMemberGuard` (run first) assigns to `req.workspaceMember`,
not `req.member` — a repo-wide grep finds zero assignments to
`req.member`. Consequence: the whole `if (user && member && (isDirect
|| member.role !== 'OWNER'))` block never executes. Private-channel
visibility (including the new DIRECT branch) is **never enforced**,
so `dm-permission-isolation.e2e.ts` will fail — an OWNER reading a
DM channel's messages gets 200, not 403. Also means the 027 "DIRECT
strips OWNER bypass" premise is a no-op in current code. Fix: read
`req.workspaceMember`, or rename the property at assignment. This is
pre-existing latent, but 027 is the first task that depends on the
branch firing, so it must land here.

## HIGH

**H1. `createOrGet` race window.** Select-then-insert outside a
serializable tx. Two simultaneous POSTs for the same pair land in
the `findFirst` gap before either inserts. The `Channel` table has
`@@unique([workspaceId, name])` so the DB will reject the second
insert with P2002 — but the service does not catch that code, so
the loser surfaces a 500 instead of retrying the select. Wrap the
insert path in a try/catch on `P2002` → re-run `findFirst` and
return the winner.

## MEDIUM

**M1. Rate limit 20 rpm documented but not implemented** (contract
§A). DM create is currently unthrottled. File as TODO(task-027-follow-1).

**M2. `DirectMessagesController.createOrGet` swallows missing body**
— returns `{ channelId: '', created: false }` instead of 400.
Client can't distinguish "no such DM" from "bad request."

## LOW

**L1. `channels.service.create` still calls `assertTypeImplemented`
which only allows TEXT.** DM creation path bypasses this via the DM
service, but any accidental POST of `type: DIRECT` through the normal
channel create API gives `CHANNEL_TYPE_NOT_IMPLEMENTED` rather than a
clearer "use /dms". Cosmetic.

**L2. `/w/:slug/dm` vs `/w/:slug/*`** — React Router v6 static wins
over splat, verified in `App.tsx` ordering; OK.

\*\*L3. `dispatcher` invalidates `['dm','list']` on every message —
cheap but wasteful. Gate on `env.message.channelType === 'DIRECT'`
when the server starts emitting it.

## Verdict

**BLOCK** on B1. H1 fix forward after B1 lands.
