# Reviewer subagent — Task 012 Attachments (NAS MinIO) + Channel ACL

## Header

- Branch reviewed: `feat/task-012-attachments-and-channel-acl`
- Diff range: `8e747c2..b1ddc1e` (develop..HEAD)
- Reviewer model: Opus 4.7 (1M context)
- Transcript length / tokens: ~58k prompt / ~5k output
- Commits: 6 (1 task doc + 5 chunk commits A / F / B / D / CEGH)
- Diff stat: 43 files, +4141 / -74

## Verdict: request-changes

The task is wide — eight chunks compressed into five commits — and the
backend scaffolding for attachments is the cleanest surface in the
diff. `S3Service` is a textbook wrapper (env-driven, forcePathStyle,
typed NoSuchKey/NotFound branches, size-safe presign), `PermissionMatrix`
preserves the 002 DENY>ALLOW invariant with the right channel-level
gating semantics, and the 7-case unit spec at
`apps/api/test/unit/auth/permissions.spec.ts` pins the matrix to the
contract. `docker-compose.prod.yml` qufox-minio service is sensible and
the `init-minio.sh` idempotency check (user-already-exists path,
`--dry-run` that tolerates missing `.env.prod`) is proper ops
hygiene. CLAUDE.md NAS-only cleanup is clean — `grep -E 'AWS|Terraform|
Helm|kubernetes|CloudWatch|Sentry|External Secrets|S3 prod'` returns
zero lines, confirmed locally.

But four items would fail against production on the first try:

1. **`isPrivate` is un-settable through the API.** The zod
   `CreateChannelRequestSchema` has no `isPrivate` field and
   `ChannelsService.create` never sets it. Both new E2Es
   (`private-channel.e2e.ts`, `private-channel-attachment.e2e.ts`)
   send `{ isPrivate: true }` in the POST body, zod silently strips
   the unknown key, the channel is created with the schema default
   `isPrivate=false`, and the "member can't see it" assertion is
   false. The whole ACL feature is unreachable from clients.
2. **`init-minio.sh` silently fails to attach the IAM policy.** The
   script copies the policy JSON into the `qufox-minio` container via
   `docker cp`, but then tries to read it from a throwaway `minio/mc`
   container (`docker run --rm`) which does not share that filesystem.
   The subsequent `mc admin policy create` call references a path
   that only exists in the MinIO server, not in the mc container, and
   the error is swallowed by `|| true`. `mc admin policy attach` also
   silently no-ops. Result: the `qufox-api` IAM user exists with no
   attached policy and gets AccessDenied on every S3 call — which
   init-minio prints as a big success banner.
3. **Presign signatures are computed for the internal endpoint.**
   `.env.prod.example` sets `S3_ENDPOINT=http://qufox-minio:9000`
   (internal container DNS), which is the endpoint the SDK signs
   against. The browser then receives a presigned URL pointing at
   `http://qufox-minio:9000/…` which it cannot reach. MinIO's
   `MINIO_SERVER_URL=https://qufox.com/attachments` cures the
   server-side signature-verification half of this, but the SDK on
   the API container has no way to know about MINIO_SERVER_URL — the
   URL it hands out will still carry `qufox-minio:9000` in the host
   header the signature is bound to. The `.env.prod.example` comment
   mentions a nonexistent `S3_ENDPOINT_PUBLIC` env; the code never
   reads one.
4. **`apply-nginx-diff.sh` has no path for the task-012-F
   `/attachments/` location.** The script is still the task-011 shape:
   it only knows about the `deploy.qufox.com` server block and appends
   a whole server at EOF. The 012-F diff is an _additive edit into an
   existing server block_. The runbook describes a manual paste; the
   switchover checklist step 9 (`apply-nginx-diff.sh`) cannot install
   012-F automatically. AC line "`apply-nginx-diff.sh --dry-run`
   recognizes the new block" is not met.

Plus two MED items (orphan GC deletes the DB row even when S3 fails;
OWNER of a private channel has no access to their own channel without
an explicit override) and a handful of MED/LOW surface gaps (the
`channel.permission.changed` outbox event is specced but not emitted;
MessageComposer drag-drop/paste/progress UI is not landed; switchover
checklist has no step for init-minio). PR body already admits the int

- e2e suites weren't run; GHA is expected to catch issues, and findings
  1 and 3 will make the e2e suite red on the first run.

Safe to merge once findings 1-4 are fixed forward; MED/LOW can ride a
`task-012-follow-*` batch.

## Findings

### 1. Private channels are unreachable: `isPrivate` missing from the create DTO

**HIGH** — `packages/shared-types/src/channel.ts:16-21`,
`apps/api/src/channels/channels.service.ts:144-155`. The zod schema
lists only `name / type / topic / categoryId`; zod's default strip
mode removes unknown keys silently, so
`POST /workspaces/:id/channels` with `{ isPrivate: true }` parses as
`{ isPrivate: undefined }`. `ChannelsService.create` never reads it,
and Prisma uses the schema default (`isPrivate = false`). Both new
E2Es rely on the flag being honored:

- `apps/web/e2e/channels/private-channel.e2e.ts:52` sends
  `{ name: 'secret', type: 'TEXT', isPrivate: true }`; expects
  non-member to NOT see the channel in `listByWorkspace` at line 67.
  Actual: channel is public → non-member sees it → `expect(false)`
  fails.
- `apps/web/e2e/channels/private-channel-attachment.e2e.ts:52` does
  the same, then expects `GET /attachments/:id/download-url` to 403.
  Actual: channel is public → non-member has READ baseline → 200,
  `expect(403)` fails.

No other route sets `isPrivate` either — `ChannelsService.update` and
`move` don't touch it. Private channels can only be created by direct
SQL today.

**Fix**: extend `CreateChannelRequestSchema` with
`isPrivate: z.boolean().optional().default(false)` and thread it into
`prisma.channel.create` at
`apps/api/src/channels/channels.service.ts:148`. Consider also
exposing `PATCH isPrivate` (OWNER only) so a public channel can be
flipped private without recreate. Contract tests at
`packages/shared-types` should pin the schema so the gap can't recur.

### 2. `init-minio.sh` silently fails to install the IAM policy

**HIGH** — `scripts/setup/init-minio.sh:103-137`. The `mc()` wrapper
at :103 runs every mc command in a fresh `docker run --rm
minio/mc:RELEASE…` container. Policy install at :132-137:

```sh
TMP_POLICY="/tmp/qufox-minio-policy-$$.json"
printf '%s\n' "$POLICY_JSON" > "$TMP_POLICY"          # host /tmp
docker cp "$TMP_POLICY" qufox-minio:/tmp/qufox-api-policy.json   # into MinIO server
mc admin policy create qufox qufox-api-policy /tmp/qufox-api-policy.json || true
mc admin policy attach qufox qufox-api-policy --user "$APP_USER" 2>/dev/null || true
```

Three layers conspire:

- `docker cp` puts the file in the `qufox-minio` container, not in
  the mc container that runs the next line.
- The mc container's `/tmp/qufox-api-policy.json` doesn't exist — mc
  returns non-zero, `|| true` swallows it.
- `mc admin policy attach` references a policy that was never
  created; `2>/dev/null || true` swallows it again.

Visible operator experience: `[init-minio] ok — MinIO ready` prints,
the app secret is displayed, the S3 creds go into .env.prod. First
real presign-upload from the API returns AccessDenied because the
`qufox-api` user has no policy attached. The cron-driven orphan GC
also fails.

(The nearby `mc anonymous set none` and `mc admin user add` calls
don't hit this bug because they don't reference a host-local file.
Just the policy stanza.)

**Fix options** (pick one):

1. Mount the JSON into the mc container as a read-only volume and
   reference the in-container path:

   ```sh
   mc_with_policy() {
     docker run --rm --network internal \
       -e MC_HOST_qufox="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@qufox-minio:9000" \
       -v "$TMP_POLICY:/tmp/policy.json:ro" \
       minio/mc:RELEASE.2024-09-09T16-17-43Z "$@"
   }
   mc_with_policy admin policy create qufox qufox-api-policy /tmp/policy.json
   ```

   Drop the `|| true` — a policy-create failure should abort.

2. Inline the policy JSON through stdin:
   `printf '%s' "$POLICY_JSON" | mc admin policy create qufox qufox-api-policy /dev/stdin`.
   Requires checking mc's stdin support on this version.
3. Write the policy to a shared host dir that's bind-mounted into
   both the mc invocation and qufox-minio (simplest: bind-mount
   `/volume3/qufox-data/tmp/` as referenced in the task-contract F
   layout).

Also: drop the `|| true` / `2>/dev/null || true` on the policy steps —
the original idempotency goal (rerun-safe) is served by `create || true`
only if the policy actually exists; use `mc admin policy info qufox
qufox-api-policy >/dev/null 2>&1 || create` instead.

### 3. Presign URL signatures are bound to the internal endpoint

**HIGH** — `apps/api/src/storage/s3.service.ts:42-54`,
`.env.prod.example:36-37`. The S3 SDK signs every presigned URL
against the host supplied in the `endpoint` constructor arg. The
example ships:

```
S3_ENDPOINT=http://qufox-minio:9000
```

— an internal container DNS name. The presigner at :81-88 and :91-94
produces URLs like:

```
http://qufox-minio:9000/qufox-attachments/<key>?X-Amz-Credential=…&X-Amz-SignedHeaders=host&X-Amz-Signature=<sig>
```

with the signature computed over `Host: qufox-minio:9000`. The browser
receives that URL (via the `POST /attachments/presign-upload`
response) and tries to PUT directly to `http://qufox-minio:9000/…`,
which does not resolve from outside the docker network. Even if the
frontend rewrote the host to `https://qufox.com/attachments/`, MinIO
would reject the request because the signed Host header no longer
matches.

`MINIO_SERVER_URL=https://qufox.com/attachments` on the qufox-minio
service (docker-compose.prod.yml:80) only influences MinIO's own
presigner and the URL the MinIO server _thinks_ it's serving. It
does not travel back to the API's SDK.

The `.env.prod.example:33-35` comment alludes to an
`S3_ENDPOINT_PUBLIC` env but the code never reads it.

Also note: `ContentLength` is signed into the PUT (`s3.service.ts:87`),
which means the browser must PUT exactly that many bytes. Good. But
the `putUrl` the browser hits is unreachable, so that never surfaces.

**Fix**: add a separate public endpoint env used for presigning:

```ts
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
this.publicClient = new S3Client({ ...commonCfg, endpoint: publicEndpoint });
this.internalClient = new S3Client({ ...commonCfg, endpoint }); // for HeadObject
```

Then presign via `this.publicClient`, HeadObject/Delete via
`this.internalClient`. `.env.prod.example` sets
`S3_PUBLIC_ENDPOINT=https://qufox.com/attachments` (or whatever
nginx proxies to), `S3_ENDPOINT=http://qufox-minio:9000` for
internal-only calls. The init-minio runbook should include a
smoke test that actually does `presign → curl PUT → curl GET`
against the external URL before declaring success.

Cheapest-possible fix: single-client with
`endpoint=https://qufox.com/attachments` — the API can reach that via
the shared nginx too (nginx-proxy-1 is on `internal`), so HeadObject

- Delete still work; the inefficiency is one extra hop through nginx
  for every server-side call, which is fine at beta.

### 4. `apply-nginx-diff.sh` doesn't know about the `/attachments/` location

**HIGH** — `scripts/setup/apply-nginx-diff.sh:42-107`,
`docs/ops/runbook-nginx-diff.md:109-153`,
`docs/ops/switchover-checklist.md:32-34`. The task-011 script
inserts a full `server { … }` block at EOF. The task-012-F diff is
described as a _`/attachments/` location block to be pasted inside the
existing `qufox.com` server_, which the current script cannot do.

Concrete impact:

- AC line: "nginx-diff updated to include the `/attachments/`
  location block; `bash scripts/setup/apply-nginx-diff.sh --dry-run`
  recognizes the new block" — unmet. `--dry-run` just prints the
  task-011 deploy.qufox.com block.
- Switchover step 9 (run `apply-nginx-diff.sh`) will not install the
  attachments location at all. Operators who follow the checklist
  as-written end up with MinIO reachable only through SSH tunnel, no
  public `/attachments/` route, and no presign upload path.
- The runbook at runbook-nginx-diff.md:112-114 explicitly warns
  "Paste inside the existing `server { server_name qufox.com; … }`
  block" — that's a manual copy-paste, and there is no automation or
  validation script tracking that it happened.

**Fix options**:

1. Add a second mode to `apply-nginx-diff.sh` that detects the
   existing `qufox.com` server block and splices a `location` stanza
   before its closing `}`. Either awk-based or an explicit marker
   comment (`# qufox-attachments-location-marker`) the script grep-
   inserts against. ~20 lines of shell.
2. Move the `/attachments/` location into a separate
   `include /etc/nginx/conf.d/qufox-attachments.conf;` directive the
   operator pastes into the qufox.com server block once; then the
   automation only has to manage the include file. (This breaks the
   single-file shape of nginx.conf, but it's the cleanest nginx
   pattern.)
3. Accept that it's manual, update the switchover checklist to add a
   step 9a: "paste the block from runbook-nginx-diff.md §Task-012-F
   by hand; `nginx -t` before reload." Remove the AC claim that
   `apply-nginx-diff.sh --dry-run` recognizes the new block.

Option 3 is the no-code path that makes the AC and reality agree.
Option 1 is needed before the next operator forgets the paste.

### 5. `attachment-orphan-gc.sh` deletes the DB row even when S3 fails

**MED** — `scripts/backup/attachment-orphan-gc.sh:63-70`. The script's
inline comment claims:

> Only delete the DB row once the object removal succeeded (or was
> already absent).

The actual shell doesn't match:

```sh
aws --endpoint-url "$S3_ENDPOINT" s3api delete-object \
  --bucket "$S3_BUCKET" --key "$KEY" >/dev/null 2>&1 || \
  log "(warn) aws delete failed for $KEY — leaving DB row for next run"
psql "$DATABASE_URL" -c "DELETE FROM \"Attachment\" WHERE id = '$ID';"
```

The `|| log "…"` substitutes `log` (exit 0) when aws fails, so the
pipeline as a whole succeeds and the next line runs unconditionally.
The DB row is deleted even on S3 failure. On a transient MinIO
outage the script will drain the whole orphan-candidates list,
leaving the S3 objects in place with no DB row pointing at them —
leaked storage forever (the script only looks for `finalizedAt IS
NULL` rows, which it just deleted).

**Fix**: restructure as an explicit if/else:

```sh
if aws --endpoint-url "$S3_ENDPOINT" s3api delete-object \
     --bucket "$S3_BUCKET" --key "$KEY" >/dev/null 2>&1; then
  psql "$DATABASE_URL" -c "DELETE FROM \"Attachment\" WHERE id = '$ID';" >/dev/null
  log "deleted id=$ID key=$KEY"
else
  log "(warn) aws delete failed for $KEY — leaving DB row for next run"
fi
```

Matches the stated atomicity guarantee.

### 6. OWNER has no access to their own private channel without an override

**MED** — `apps/api/src/auth/permissions.ts:99-116` vs
`apps/api/src/channels/channels.service.ts:74,90` and
`apps/api/src/channels/guards/channel-access.guard.ts:68`. The three
enforcement sites disagree on OWNER semantics:

- `listByWorkspace` explicitly lets OWNER through:
  `if (memberRow?.role === 'OWNER') return true;` (line 90).
- `ChannelAccessGuard` explicitly lets OWNER through:
  `if (user && member && member.role !== 'OWNER') { … }` (line 68).
- `ChannelAccessByIdGuard` used by the **attachment** surface does
  **not** bypass OWNER. It runs the full
  `PermissionMatrix.effective`, which for
  `{ role: OWNER, isPrivate: true, overrides: [] }` returns
  `channelOk = hasExplicitAllow = false` → `allow = 0` →
  `effective = 0`. OWNER fails `requireUpload` and `requireRead`.

Manifested footgun: OWNER creates a private channel, OWNER tries to
upload an attachment to it, 403 `CHANNEL_NOT_VISIBLE`. The UI would
show the channel (listByWorkspace bypass) but attachments fail.

**Fix options**:

1. Add an OWNER bypass to `PermissionMatrix.effective`:
   `if (input.role === 'OWNER') return ROLE_BASELINE.OWNER & ~channelDeny;`
   Keeps the three sites consistent with one change.
2. Auto-create a USER-principal override row with
   `allowMask = ALL_PERMISSIONS` for the creator when an OWNER/ADMIN
   creates a private channel. Aligns with how Discord-likes seed the
   "channel owner sees the channel" invariant.
3. Route the attachment surface through ChannelAccessGuard (drop
   ChannelAccessByIdGuard entirely), then the OWNER bypass there
   carries over. Needs the channel id moved to a path param, which
   is a bigger refactor.

Option 1 is the 1-line fix that matches what the other two sites do.
Option 2 is more principled but ships a new outbox event and a
Prisma transaction. Either way, add a unit case to permissions.spec
pinning `OWNER can access a private channel with no overrides`.

### 7. `channel.permission.changed` outbox event is spec'd but not emitted

**MED** — `docs/tasks/012-attachments-and-channel-acl.md:165-172` vs
`apps/api/src/channels/channels.service.ts:307-360`. The task
contract for D specifies:

> `POST /channels/:chid/members` … Emits outbox event
> `channel.permission.changed` (per-user, with `effective` mask
> attached). The added user's WS dispatcher refreshes channel list;
> a removed user's dispatcher redirects out of the channel if
> currently viewing it.

`ChannelsService.addChannelMemberOverride` does the upsert and
returns, with no `this.outbox.record(…)` call. Grepping the whole
`apps/api/src` for `channel.permission.changed` or
`channelPermissionChanged` returns zero hits. The realtime
dispatcher has no subscriber for the event either.

Functional consequence: a freshly-added member sees the private
channel on next page reload (because listByWorkspace recomputes
visibility on each call), but an already-connected WS session won't
refresh its channel list automatically. Worse, a removed member
stays parked on the channel page until they manually navigate away
or reload. The E2E `private-channel.e2e.ts` doesn't catch this
because it issues fresh `GET /channels` calls rather than observing
WS events.

**Fix**: wrap `prisma.channelPermissionOverride.upsert` in a
`prisma.$transaction` with `this.outbox.record(tx, { aggregateType:
'channel', aggregateId: channelId, eventType: 'channel.permission.
changed', payload: { workspaceId, channelId, actorId,
targetUserId, effectiveBefore, effectiveAfter } })`. The dispatcher
side needs a new `@OnEvent('channel.permission.**')` subscriber in
`apps/api/src/realtime/` that emits to the affected user's WS
namespace.

### 8. Attachment finalize bypasses channel ACL

**MED** — `apps/api/src/attachments/attachments.controller.ts:63-70`
and `apps/api/src/attachments/attachments.service.ts:147-172`.
Finalize only checks `att.uploaderId === callerId`. If the uploader
is kicked from the workspace OR the channel between presign and
finalize, the finalize call still succeeds and links the S3 object
to a message in a channel the uploader no longer has access to.

The brief acknowledges this as a known UX gap ("the presign already
gated the PUT — if the caller could presign, they can finalize").
That's a defensible position in principle, but the stated policy
for download-url is the opposite ("READ bit at download time, not at
presign time"). The two paths have different security models and
neither file annotates why.

**Fix**: call `this.channelAccess.requireUpload(channel, callerId)`
inside `finalize` before `prisma.attachment.update`. One extra
Prisma query per finalize, matches the download path's recompute-
on-every-call model. Side benefit: an uploader who lost
UPLOAD_ATTACHMENT due to a fresh override between presign and
finalize can't sneak the attachment through. Document the re-check
in the attachment-upload runbook.

Alternative: keep the current shape, add a comment block explaining
the divergence (uploader stability vs reader freshness).

### 9. `attachment-upload.e2e.ts` runs nowhere

**MED** — `apps/web/e2e/messages/attachment-upload.e2e.ts:21-26`. The
test's own docstring says "runs on GitHub Actions via
docker-compose.test.yml (task-011-D); on the NAS the MinIO service
isn't in the test compose so this test is GHA-only." But grepping
`docker-compose.test.yml` shows no `test-minio` or `minio` service.
The test will fail on GHA too — presign succeeds because the API
returns a URL, but `ctx.request.put(presign.putUrl, …)` can't reach
MinIO because there's no MinIO container up.

Same story for the two other new E2Es — all three call the
attachment endpoints but nothing starts MinIO for the test pipeline.

**Fix**: add a `test-minio` service to `docker-compose.test.yml`
(based on `minio/minio:RELEASE.2024-09-13T20-26-02Z`, ephemeral
volume, health check), wire `test-api`'s S3\_\* env at it, and add a
setup step that creates the `qufox-attachments` bucket (inline mc
command or a one-shot init container). Also verify `test-api`'s
presign returns an URL reachable from the Playwright browser — for
the same reason as finding #3, the presign will likely need to sign
against the host-exposed test-minio port (e.g. `:9000` mapped to
`localhost:49000`).

### 10. Runbook-backup-restore never got the "Migrate prior backups" section

**LOW** — `docs/tasks/012-attachments-and-channel-acl.md:30-33` vs
the actual diff for `docs/ops/runbook-backup-restore.md`. The task
contract for A says:

> `docs/ops/runbook-backup-restore.md` gains a "Migrate prior
> backups" section: single rsync command the operator runs once to
> move `/volume1/backups/qufox` → `/volume3/qufox-data/backups/qufox`.

The diff is a simple path-replace across the file — no new section.
The rsync procedure only lives in `docs/ops/deploy-inventory.md:76-81`.
That note is the one an operator would find if they were reading
the inventory; an operator reading the restore runbook wouldn't.

Separately, `runbook-backup-restore.md:109` still says
`df -h /volume1` — missed during the path migration. Should be
`/volume3`.

**Fix**: port the 3-line migration note from deploy-inventory.md
into runbook-backup-restore.md under a new
`## One-time: migrate /volume1 backups` section above
`## Full restore procedure`. Also patch line 109.

### 11. MessageComposer drag-drop / paste / progress UI is absent

**LOW** — `apps/web/src/features/messages/MessageComposer.tsx` (not
diffed) vs task contract C:

> `MessageComposer` accepts: drag-drop, paste-from-clipboard, file
> picker. Each pending file becomes a card under the input with
> upload progress (`xhr.upload.onprogress`), cancel button, and
> retry on failure.

Only `AttachmentsList.tsx` (the read-side renderer for an already-
uploaded attachment) landed. The PR body at
`012-*.PR.md:65-67` already admits this: "Drag-drop + paste into
MessageComposer is deferred — not landed in this commit." No
follow-up task is tracked.

**Fix**: either (a) land the composer changes before merge, or (b)
add `TODO(task-012-follow-compose)` + update the task status
document so future agents see the scope truncation. Ship as-is only
if the beta doesn't block on end-user-driven upload.

### 12. `attachment-orphan-gc.sh --dry-run` requires env that isn't needed for dry-run

**LOW** — `scripts/backup/attachment-orphan-gc.sh:19-23`. The top-of-
script `: "${DATABASE_URL:?}"` and four S3\_\* `:?` checks fire before
arg parsing. Running `bash scripts/backup/attachment-orphan-gc.sh
--dry-run` without env exits non-zero with:

```
scripts/backup/attachment-orphan-gc.sh: line 19: DATABASE_URL: DATABASE_URL required (postgres://qufox:...@qufox-postgres-prod:5432/qufox)
```

AC line at task-doc:325 says:
`bash scripts/backup/attachment-orphan-gc.sh --dry-run lists
candidates without deleting` — unmet in the "fresh checkout, no env
set" case that an operator / CI syntax-smoke would hit. (Under the
cron container it works because the env is set.)

**Fix**: move the `:?` checks to after arg parsing, and allow
dry-run to skip the DB + S3 checks (just print `"(dry-run: would
require DATABASE_URL / S3_*)"` and exit 0). Matches init-minio.sh's
dry-run-tolerates-missing-env pattern at lines 32-44.

### 13. `ChannelAccessGuard` checks overrides with `count > 0`, diverging from the full matrix

**LOW** — `apps/api/src/channels/guards/channel-access.guard.ts:65-83`.
The guard is visibility-only: a single row with `allowMask > 0` for
the caller lets them "see" the channel. Then route-specific code
re-enters `PermissionMatrix.effective` for the actual bit check.
Subtle divergence: a caller with a USER-level row carrying
`allowMask=0, denyMask=READ` (pure deny, no allow) and a role row
`allowMask=READ` will:

- pass the ChannelAccessGuard visibility check (role row matches,
  `allowMask > 0`)
- fail any route that calls `requireRead` (deny bit wins in matrix)

Net: non-leaking (they can't read anything), but they can probe
"does this channel exist?" with a 403 instead of a 404
`CHANNEL_NOT_VISIBLE`. Minor information leak.

**Fix**: make the guard call `PermissionMatrix.effective(...)` with
READ as the required bit, instead of `count`. Single source of truth.

### 14. `addChannelMemberOverride` silently allows setting both allow and deny to 0 on the same bit

**LOW** — `apps/api/src/channels/channels.controller.ts:133-151` and
`apps/api/src/channels/channels.service.ts:335-351`. `{ userId,
allowMask: 0, denyMask: 0 }` creates (or updates) an override row
with zero impact — it's harmless but wastes a row and makes the
table pollute-able. There's no validation that `allowMask &
denyMask === 0` (deny always wins anyway but a contradictory row is
operator confusion).

**Fix**: in the controller, reject the request if both masks are 0
(with a VALIDATION_FAILED) and emit a clearer error when
`allowMask & denyMask != 0`. ~5 lines.

### 15. Switchover checklist has no step for task-012-F infra

**LOW** — `docs/ops/switchover-checklist.md:23-38`. The checklist
lists steps 1-14 from task-011. Nothing for init-minio, MinIO
bring-up, `/attachments/` nginx paste, or first MinIO backup smoke.
Operators following the checklist post-012 will bring the API up
with S3_ENDPOINT set but no MinIO running — the first presign call
500s on connection-refused.

**Fix**: add steps between current 9 and 10:
`9a. /attachments/ nginx paste (see runbook-nginx-diff § Task-012-F)`,
`9b. docker compose up -d qufox-minio`,
`9c. bash scripts/setup/init-minio.sh --dry-run && bash scripts/setup/init-minio.sh`,
`9d. paste S3_ACCESS_KEY_ID/SECRET printed by the previous step into
.env.prod and docker restart qufox-api`,
`9e. presign round-trip smoke from the API container`.

### 16. `CREATE TYPE "AttachmentKind"` in the migration is harmless but redundant-looking

**NIT** — `apps/api/prisma/migrations/20260421000000_add_attachment_table/migration.sql:21`.
The migration creates the enum type directly; Prisma's client
generation reads the schema.prisma enum declaration and relies on
the same DB-side type. This is standard Prisma practice — the
brief's concern about "two CREATE TYPE statements" is unfounded
(prisma generate doesn't run DDL). No change needed; mention only to
close the review-brief question.

### 17. Positives

- **`PermissionMatrix` is textbook.** `apps/api/src/auth/permissions.ts`
  implements `effective = (channelOk ? base | channelAllow : 0) &
~channelDeny` with the `hasExplicitAllow` gate only on private
  channels. The 7-case unit spec at
  `apps/api/test/unit/auth/permissions.spec.ts` covers every
  branch + pins DENY > ALLOW. Future-ready: bit slots 0x0100+
  reserved for voice/video.
- **`S3Service.sanitizeFilename` (s3.service.ts:146-151)** is
  properly paranoid. `\.\.+/g → .` collapses `../../x` to `./x/x`
  before the `[^A-Za-z0-9._-]` filter strips the `/`, so a hostile
  filename lands as a single path segment no matter what. Length-
  capped at 120, empty-string fallback to `'file'`. Good.
- **`Attachment` migration uses partial indexes to the hilt.**
  `Attachment_messageId_idx WHERE messageId IS NOT NULL` (avoids
  indexing unfinalized rows), `Attachment_orphan_idx` on
  `(uploaderId, createdAt) WHERE finalizedAt IS NULL` (point query
  for the GC path), `Attachment_channel_client_uniq` partial unique
  for idempotency without rejecting server-generated NULL keys.
  Three-index design.
- **Presign idempotency** (`attachments.service.ts:86-135`) handles
  the P2002 race correctly: if two presign-upload calls with the
  same `clientAttachmentId` arrive concurrently, the loser catches
  the unique-constraint violation and re-fetches the winner's row,
  returning the same attachmentId to both callers. The conflict-
  params check (mime / size / uploader) comes first so a deliberate
  retry with different content fails loudly with 409, not
  surreptitiously.
- **`finalize` does a real HeadObject.** The byte-count match at
  `attachments.service.ts:162-167` catches truncated uploads.
  Finalize is idempotent at :153 (`if (att.finalizedAt) return`).
  Clean three-phase state machine.
- **`docker-compose.prod.yml` qufox-minio** is minimal and correct:
  restart unless-stopped, curl health probe at
  `/minio/health/live`, bind mount at `/volume3/qufox-data/minio`
  matching the data layout. No accidental port publish (admin
  console 9001 is intentionally NOT `ports:`).
- **`minio-backup.sh`** uses `rsync -a --delete --link-dest <PREV>`
  — hardlinks unchanged objects against the previous snapshot, real
  copies for new/changed files, O(delta) disk cost, O(files) inode
  cost. Retention prunes oldest snapshots; same-hour re-runs are
  idempotent. `du -sh` at the end for observability.
- **CLAUDE.md NAS-only cleanup** is thorough. Grep for
  `AWS|Terraform|Helm|kubernetes|CloudWatch|Sentry|External Secrets|
S3 prod` returns zero lines. The "NAS-only" callout at the top of
  Tech Stack (lines 11-17) matches the `project_prod_deploy.md`
  memory. MCP servers section drops cloud-related servers, adds
  note about no remote MCP expected. CD section matches 009/010/011
  reality (reviewer subagent → direct merge → webhook → NAS auto-
  deploy). IaC section points at `/volume2/dockers/qufox/` + the
  actual scripts.
- **`ChannelPermissionOverride` schema choices** are sound:
  `VARCHAR(64)` for principalId (fits both UUID and WorkspaceRole
  literal), composite unique on (channelId, principalType,
  principalId), separate allow/deny mask columns so `allow & ~deny`
  is a single int op. Migration keeps it NOT NULL + DEFAULT 0 so
  backfill isn't needed.
- **Attachment channel-id validation in
  `addChannelMemberOverride`** (channels.service.ts:327-334):
  filters by `workspaceId` so an ADMIN of workspace A can't add a
  USER override on workspace B's private channel. Correct cross-
  workspace gate.

## Suggested follow-up TODOs

- **TODO(task-012-follow-1)**: add `isPrivate` to
  `CreateChannelRequestSchema` + ChannelsService.create + E2E
  scaffolding. Unblocks both new E2Es. (Finding #1.)
- **TODO(task-012-follow-2)**: fix `init-minio.sh` policy install
  to mount the JSON into the mc container or pipe via stdin.
  (Finding #2.)
- **TODO(task-012-follow-3)**: split S3_ENDPOINT into internal +
  public; the presigner uses public, HeadObject/Delete use
  internal. Add a presign-roundtrip smoke to init-minio.sh.
  (Finding #3.)
- **TODO(task-012-follow-4)**: teach `apply-nginx-diff.sh` the
  `/attachments/` location injection OR update switchover
  checklist + AC to reflect the manual paste step. (Finding #4.)
- **TODO(task-012-follow-5)**: restructure attachment-orphan-gc.sh
  aws → psql sequence with explicit if/else. (Finding #5.)
- **TODO(task-012-follow-6)**: pick a resolution for the OWNER-
  private-channel footgun — either matrix-level OWNER bypass or
  auto-seeded override row on create. (Finding #6.)
- **TODO(task-012-follow-7)**: emit `channel.permission.changed`
  outbox event + realtime dispatcher subscriber; E2E asserts WS
  channel-list refresh. (Finding #7.)
- **TODO(task-012-follow-8)**: decide finalize ACL policy — either
  add requireUpload at finalize time or annotate the divergence.
  (Finding #8.)
- **TODO(task-012-follow-9)**: add `test-minio` to
  docker-compose.test.yml + bucket-init step + thread the test-minio
  port through test-api presign wiring. (Finding #9.)
- **TODO(task-012-follow-10)**: port migration rsync note into
  runbook-backup-restore.md + patch `df -h /volume1` → `/volume3`.
  (Finding #10.)
- **TODO(task-012-follow-11)**: land MessageComposer drag/paste/
  progress UI or record deferment explicitly. (Finding #11.)
- **TODO(task-012-follow-12)**: allow `--dry-run` without env in
  attachment-orphan-gc.sh. (Finding #12.)
- **TODO(task-012-follow-13)**: route ChannelAccessGuard through
  PermissionMatrix.effective so deny bits are consistent. (Finding #13.)
- **TODO(task-012-follow-14)**: validate allow/deny masks in
  POST `/:chid/members`. (Finding #14.)
- **TODO(task-012-follow-15)**: extend switchover-checklist.md for
  task-012-F infra bring-up. (Finding #15.)

## Re-review (post-fix 9c73631)

- Model: Opus 4.7 (1M context)
- Transcript: ~18k prompt / ~1.2k output

### Verdict: request-changes

Seven of nine items are closed cleanly. HIGH-2 is NOT fixed — the exact
broken pattern from the original finding is still in place verbatim
(the `mc()` wrapper runs in a throwaway container that never sees the
policy JSON, and `|| true` swallows the failure). MED-6 is closed in
practice via a clever path (HIGH-1's auto-seeded creator override) but
the matrix itself never got the spec'd OWNER bypass and no new spec
cases were added, so non-creator OWNERs of a private channel (e.g.
after `transferOwnership` or DB restore) still return `effective = 0`
from the matrix. HIGH-2 is a BLOCKER — shipping with it means the
qufox-api IAM user has no policy attached and every presign PUT
returns AccessDenied in prod, which is exactly the scenario the
original review called out. No new regressions detected elsewhere.

### Per-finding status

1. **HIGH-1 isPrivate** — ✅
   `packages/shared-types/src/channel.ts:25` adds
   `isPrivate: z.boolean().optional().default(false)`, export uses
   `z.input<...>` at :30 keeping the field optional for legacy
   callers, `channels.service.ts:156` threads it into
   `prisma.channel.create`, and :165-186 seed a USER-principal
   override with `allowMask=0xff` for the creator. `UpdateChannel`
   schema also gains `isPrivate` at :37.
2. **HIGH-2 init-minio** — ❌
   `scripts/setup/init-minio.sh:132-138` is the SAME broken shape
   from the original review: `docker cp` into `qufox-minio`, then
   `mc admin policy create … /tmp/qufox-api-policy.json || true`
   from a throwaway mc container that never saw the file. No
   `mc_with_policy()` volume-mount wrapper, no `mc admin policy info`
   idempotency check, `|| true` still swallows the error. The
   acceptance criteria in the prompt ("uses `mc_with_policy()` that
   volume-mounts the host policy JSON") is unmet. BLOCKER.
3. **HIGH-3 presign endpoint** — ✅
   `s3.service.ts:27-29,46,63-64` splits `internalClient` /
   `publicClient`. `presignPut`/`presignGet` use `publicClient`
   (:99, :104); `headObject`/`deleteObject` use `internalClient`
   (:116, :133). `.env.prod.example:33-43` documents both endpoints
   and the fall-through behavior. Fallback to `S3_ENDPOINT` when
   `S3_PUBLIC_ENDPOINT` unset keeps dev single-origin working.
4. **HIGH-4 apply-nginx-diff --attachments** — ✅
   `apply-nginx-diff.sh:36,57-84` adds a second mode that prints the
   `location /attachments/` block, idempotency via
   `grep -qE 'location[[:space:]]+/attachments/'` on the target conf
   (:73), does NOT modify `nginx.conf`, and prints the manual paste
   - verification steps. The deploy.qufox.com path at :87+ is
     unchanged.
5. **MED-5 orphan-gc atomicity** — ✅
   `attachment-orphan-gc.sh:78-84` is now an explicit
   `if aws … ; then psql … ; else log "(warn) …"; fi`. DB row stays
   when S3 delete fails. Matches the stated atomicity guarantee.
6. **MED-6 OWNER private-channel access** — ⚠
   The fix took option 2 (auto-seed USER override on create) from the
   original review, which works for the happy path. But the matrix
   at `permissions.ts:99-116` has NO `if (input.role === 'OWNER')`
   bypass, and `permissions.spec.ts` has NO "OWNER can access a
   private channel with no overrides" test case (contra the prompt's
   "Two new spec cases" expectation). Non-creator OWNERs created via
   `transferOwnership` or manual DB restore would still get
   `effective=0` on channels whose creator-override was for the
   previous OWNER. Works for MVP, time-bomb for later. Follow-up.
7. **MED-7 channel.permission.changed outbox** — ✅
   `channels.service.ts:372-405` wraps the upsert in
   `prisma.$transaction` and calls
   `outbox.record(tx, { eventType: 'channel.permission.changed', … })`
   with payload carrying workspaceId/channelId/targetUserId/allow/
   deny/effectiveMask. Grep confirms the event type is now emitted.
   Dispatcher-side subscriber is not in this diff — that ships when
   the realtime-refresh piece lands; at least the outbox event exists.
8. **MED-8 finalize ACL** — ✅
   `attachments.controller.ts:63-87` now loads the attachment +
   channel and calls `channelAccess.requireUpload(channel, user.id)`
   before `attachments.finalize`. Two new `DomainError`s for missing
   attachment + channel-gone states. Matches download's
   recompute-on-every-call policy.
9. **LOW-12 orphan-gc dry-run without env** — ✅
   `attachment-orphan-gc.sh:35-39` short-circuits `--dry-run` when
   any of DATABASE*URL / S3*\* is unset, logs
   `"--dry-run without DB / S3 env — would list candidates here"`,
   exits 0. The `:?` checks at :41-45 now run only when we would
   actually hit the DB.

### New issues (if any)

- None beyond the two above. The MED-6 partial-fix is a regression
  risk but not introduced by this commit — it's the same matrix
  shape as before, and the new creator-override path covers today's
  code paths. The `channels.service.ts:406` `void effective;` is
  cosmetically odd (destructured-but-unused to please no-unused)
  but harmless.
- Note: reviewer MED-9 (test-minio in docker-compose.test.yml) was
  in the original review but is not in the prompt's 9-item scope,
  and the fix commit does not touch it. Still open.

### Merge recommendation

request-changes. HIGH-2 (BLOCKER) must be fixed before merge: the
policy install needs to actually run. Either (a) add the
`mc_with_policy()` wrapper that `-v` mounts the host policy JSON
into the mc container, drop `|| true` on the create step, and gate
with `mc admin policy info` for idempotency; or (b) pipe via stdin
if this mc release supports it. Without this, the first presign PUT
in prod returns AccessDenied — the exact failure mode the original
review flagged.

MED-6 can ride a `task-012-follow-6` (add OWNER bypass to
`PermissionMatrix.effective` + spec cases pinning non-creator OWNER
access) — not a merge blocker given the creator-override path
covers current callers.
