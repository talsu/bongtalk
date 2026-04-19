# Task 012 — Attachments (NAS MinIO) + Channel ACL Base (private channels + permission overrides)

## Context

Two of the last big MVP gaps land together: users can't send files
or images, and workspace OWNERs can't make a channel private. 005
reserved `Channel.isPrivate` but never wired it; 002's
`PermissionMatrix` only covers workspace-level roles, with no channel
override layer. The two systems share an enforcement boundary —
**a private channel's attachments must respect that channel's ACL**
— so they ship as one task. ACL regressions show up as attachment
regressions in the same PR.

The object storage backend is **MinIO running on this NAS**, not
AWS S3. The earlier scaffold mentioned "MinIO dev / S3 prod" but
the user's running this on Synology with no AWS account; everything
is self-hosted under `/volume3/qufox-data/`. Task 012 also corrects
the lingering AWS / K8s references in CLAUDE.md.

## Scope (IN)

### A. Backups + storage location migration

- `scripts/backup/db-backup.sh`, `redis-backup.sh`, `restore-test.sh`
  default `BACKUP_DIR=/volume3/qufox-data/backups/qufox`. Was
  `/volume1/backups/qufox` in 009.
- `.env.deploy.example` `BACKUP_DIR` example updated to the new path.
- `compose.deploy.yml` `qufox-backup` service: `volumes` line points
  the `BACKUP_DIR` mount at `/volume3/qufox-data/backups/qufox`.
- `docs/ops/runbook-backup-restore.md` gains a "Migrate prior
  backups" section: single rsync command the operator runs once
  to move `/volume1/backups/qufox` → `/volume3/qufox-data/backups/
qufox`. Do not touch existing files automatically.
- New layout under `/volume3/qufox-data/`:
  ```
  /volume3/qufox-data/
  ├── minio/           (MinIO data dir, populated in F)
  ├── backups/qufox/
  │   ├── postgres/    (existing scripts/backup output goes here)
  │   ├── redis/
  │   └── minio/       (new, populated in F)
  └── tmp/             (presign uploads in flight, restore-test workspaces)
  ```

### B. Attachments backend (TODO(task-017) closure)

- Prisma `Attachment` table:
  ```
  id           uuid pk
  messageId    uuid fk -> Message.id ON DELETE CASCADE
  uploaderId   uuid fk -> User.id (denormalized for ACL check on download)
  kind         enum IMAGE | VIDEO | FILE
  mime         varchar(127)
  sizeBytes    bigint
  storageKey   text                  -- "<workspaceId>/<channelId>/<attId>/<filename>"
  originalName text
  finalizedAt  timestamptz null      -- set after S3 head-check passes
  createdAt    timestamptz default now()
  ```
  Indexes: `(messageId)`, `(uploaderId, finalizedAt)` for orphan GC.
- `S3Service` abstraction in `apps/api/src/storage/`:
  - Single class, env-driven (`S3_ENDPOINT`, `S3_REGION`,
    `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
    `S3_PRESIGN_PUT_TTL_SEC`, `S3_PRESIGN_GET_TTL_SEC`).
  - dev / prod both point at the local MinIO endpoint
    (`http://qufox-minio:9000` from inside the network, the same
    container address in dev compose). The "AWS region" string is
    cosmetic for MinIO (`us-east-1` works).
  - Uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` —
    AWS SDK is fully MinIO-compatible.
- Endpoints under `/attachments`:
  - `POST /attachments/presign-upload` — body
    `{ clientAttachmentId, channelId, mime, sizeBytes,
originalName }`. Validates: channel access (delegated to
    ChannelAccessGuard from 005), mime allowlist, sizeBytes ≤
    100 MB. Returns `{ attachmentId, putUrl, key, expiresAt }`.
    **Idempotency:** `clientAttachmentId` is a client-generated uuid;
    second call with the same id (and same channel) returns the
    same record. Stored in DB with `finalizedAt = NULL`.
  - `POST /attachments/:id/finalize` — body
    `{ messageDraftId? | messageId? }`. Performs an S3 `HeadObject`
    to confirm the upload landed and the byte-size matches what
    was declared, then sets `finalizedAt` and links to the message.
  - `GET /attachments/:id/download-url` — returns a presigned GET
    URL (TTL 30 min, configurable via env). Verifies the caller
    has read access to the attachment's channel **at request time**
    (not at presign time — token leakage is a known limit).

### C. Attachments frontend

- `MessageComposer` accepts: drag-drop, paste-from-clipboard, file
  picker. Each pending file becomes a card under the input with
  upload progress (`xhr.upload.onprogress`), cancel button, and
  retry on failure.
- Upload flow client-side:
  1. Create `clientAttachmentId` (uuid v4 in browser).
  2. POST `/attachments/presign-upload` → `{ attachmentId, putUrl }`.
  3. PUT directly to `putUrl` (full body, no chunking — 100 MB cap
     fits in one request; chunked is a future task).
  4. On 2xx, POST `/attachments/:id/finalize` with the message's
     `messageDraftId`.
  5. When the user submits the message, the message create call
     includes `attachmentIds: [...]`.
- `MessageItem` rendering:
  - `kind=IMAGE` → inline thumbnail (lazy `<img>`, native
    intrinsic size; no server-side thumbnail), click → modal
    lightbox with full image. URL refresh on lightbox open if
    presign older than 25 min.
  - `kind=VIDEO` → `<video controls preload="metadata">`.
  - `kind=FILE` → file card (icon + filename + size + download
    button).
- E2E `apps/web/e2e/attachment-upload.e2e.ts`: pick a 1 MB png →
  see upload progress → see message with image preview → click
  preview → lightbox shows full image → click download → file
  arrives in download dir.

### D. Channel ACL backend (TODO(task-016) closure)

- `Channel.isPrivate` activated. Migration adds the column with
  default `false`, NOT NULL — Postgres metadata-only ALTER (no
  table rewrite) since column has a default and is added at the
  end. Backfill not needed.
- `ChannelPermissionOverride` table:
  ```
  id            uuid pk
  channelId     uuid fk -> Channel.id ON DELETE CASCADE
  principalType enum ROLE | USER
  principalId   text         -- WorkspaceRole literal or User.id
  allowMask     int default 0
  denyMask      int default 0
  createdAt     timestamptz
  updatedAt     timestamptz
  unique (channelId, principalType, principalId)
  ```
- Permission masks (`apps/api/src/auth/permissions.ts`):
  ```
  0x0001  READ
  0x0002  WRITE_MESSAGE
  0x0004  DELETE_OWN_MESSAGE
  0x0008  DELETE_ANY_MESSAGE
  0x0010  MANAGE_MEMBERS
  0x0020  MANAGE_CHANNEL
  0x0040  UPLOAD_ATTACHMENT
  0x0080  PIN_MESSAGE
  ```
  (slots 0x0100+ reserved for future: voice JOIN, voice SPEAK, etc.)
- `PermissionMatrix.effective(workspaceRole, channel, overrides)`:
  ```
  base       = workspaceRoleMask                                 // from 002
  channelOk  = isPrivate ? (overrides has explicit ALLOW for me) : true
  allow      = base | (channelAllow if channelOk)
  deny       = workspaceGlobalDeny | channelDeny
  effective  = allow & ~deny
  ```
  DENY > ALLOW invariant from 002 preserved. Add a property test
  asserting that adding a ROLE-level allow never overrides a USER-
  level deny on the same channel.
- `ChannelAccessGuard` enhanced: private channel + non-member →
  `403 CHANNEL_NOT_VISIBLE` (new ErrorCode); existing public
  channel paths unchanged.
- `GET /workspaces/:id/channels` filters out private channels the
  caller can't see, **before** returning — no 404 information leak.
  EXPLAIN check: filter pushed down via `(workspaceId, isPrivate)`
  partial index OR by a join on overrides; whichever the planner
  picks, no seq scan.
- `POST /channels/:chid/members` (new) — OWNER/ADMIN only, body
  `{ userId, allowMask?, denyMask? }`. Creates / updates an
  override row with `principalType=USER`. Emits outbox event
  `channel.permission.changed` (per-user, with `effective` mask
  attached). The added user's WS dispatcher refreshes channel
  list; a removed user's dispatcher redirects out of the channel
  if currently viewing it.

### E. Integrated ACL on attachments

- `POST /attachments/presign-upload` checks UPLOAD_ATTACHMENT bit
  on effective(channel, caller) — 403 otherwise.
- `GET /attachments/:id/download-url` checks READ bit on
  effective(attachment.channel, caller) — 403 otherwise.
- E2E `apps/web/e2e/private-channel-attachment.e2e.ts`: A creates
  a private channel → uploads image → guesses attachmentId pattern
  → B (non-member) calls `GET /attachments/:id/download-url` → 403. B is added → succeeds. B is removed → 403 again.

### F. NAS storage infra

- Extend `docker-compose.prod.yml`:
  ```yaml
  qufox-minio:
    image: minio/minio:RELEASE.2024-09-13T20-26-02Z
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_SERVER_URL: https://qufox.com/attachments
      MINIO_API_CORS_ALLOW_ORIGIN: https://qufox.com
    volumes:
      - /volume3/qufox-data/minio:/data
    networks: [internal]
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:9000/minio/health/live']
      interval: 30s
      timeout: 5s
      retries: 3
  ```
- `.env.prod` adds `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`
  (openssl rand -hex 24). `.env.example` documents both.
- `scripts/setup/init-minio.sh` — creates the bucket
  (`qufox-attachments`), sets bucket policy to private (all access
  via presign), creates an app-scoped IAM user the API uses (not
  the root credentials). Idempotent. `--dry-run` supported.
- `scripts/backup/minio-backup.sh` — rsync `--link-dest`
  incremental snapshot from `/volume3/qufox-data/minio/` to
  `/volume3/qufox-data/backups/qufox/minio/<date>/`. Hourly cron
  (every 4h actually — `0 */4 * * *`) so the data is at most 4h
  stale; full snapshot retained for 14 days.
- `scripts/backup/minio-restore-test.sh` — picks a random object
  from the most recent snapshot, spins an ephemeral MinIO
  container with the snapshot mounted, GETs the object, asserts
  byte-for-byte equality with the source. Weekly cron.
- `compose.deploy.yml` `qufox-backup` cron entries gain
  `BACKUP_CRON_MINIO`, `RESTORE_TEST_CRON_MINIO`.
- nginx-diff (`docs/ops/runbook-nginx-diff.md` updated) adds:
  ```
  location /attachments/ {
    proxy_pass http://qufox-minio:9000/;
    proxy_set_header Host $host;
    client_max_body_size 100m;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 600s;
  }
  ```
  Streaming PUT (large body) and GET both pass through. The
  `/attachments-console` route is left out by default — the
  operator opens the MinIO admin console via SSH tunnel.

### G. Attachment orphan GC

- `scripts/backup/attachment-orphan-gc.sh` — runs nightly, deletes
  `Attachment` rows where `finalizedAt IS NULL AND createdAt <
now() - interval '24 hours'`, then deletes the corresponding S3
  object. Idempotent (deleting a non-existent S3 key is a no-op
  in the SDK). Records `qufox_attachment_orphans_deleted_total`
  counter (the webhook's prom-client registry from 010-D).
- `compose.deploy.yml` adds `ORPHAN_GC_CRON` (`30 4 * * *`).
- Integration test asserts: a `presign-upload` followed by no
  `finalize` → after 24h-simulated tick → row deleted, S3 object
  deleted.

### H. CLAUDE.md NAS-only correction

- Tech Stack section: `Object Storage` line → "MinIO
  (single-tenant, NAS docker-compose, dev/prod identical)";
  `Container` line → "Docker + docker-compose (dev/prod, no K8s
  on this deployment)".
- MCP Servers section: drop `kubernetes-staging`,
  `kubernetes-prod`, `sentry`. Keep `postgres-local`,
  `redis-local`, `playwright`, `github`, `filesystem`. Add note
  about no remote/cloud MCP servers being expected.
- CD section: rewrite to match what 009/010/011 actually built —
  `feature → reviewer subagent → direct merge to develop → AI
smoke + eval → develop merge to main → webhook auto-deploy
on NAS → /readyz gate + auto rollback on failure`.
- IaC section: drop Terraform / K8s / Helm / AWS Secrets Manager
  / External Secrets Operator. Replace with: "infra is the
  contents of `/volume2/dockers/qufox/` (`docker-compose.prod.yml`,
  `compose.deploy.yml`, `scripts/setup/`, `scripts/deploy/`,
  `scripts/backup/`). Secrets in `.env.prod` and `.env.deploy`,
  generated by `scripts/setup/init-env-deploy.sh` and
  `scripts/setup/init-minio.sh`. sops/age migration is a future
  task."
- Production Observability section: drop CloudWatch / Sentry
  references. Keep Prometheus / Grafana / OTEL (already wired in
  007). Loki self-hosted on NAS is left as TODO(task-019).
- One-line note at the top of "Tech Stack" reaffirming
  NAS-only (so a future agent reading CLAUDE.md alone, without
  this memory, gets the constraint).

## Scope (OUT) — future tasks

- Reactions — TODO(task-023)
- Threads — TODO(task-024)
- Full-text search — TODO(task-025)
- Multipart / chunked upload for files > 100 MB — separate task
- Server-side image thumbnail / video transcode — separate task
- Virus scanning (ClamAV) — beta out of scope
- Audit log on permission changes — folds into TODO(task-015)
- Per-message ACL (ephemeral message etc.) — out of scope
- MinIO HA / distributed mode — beta out of scope
- sops / age secret encryption — separate ops task
- Loki log aggregation — TODO(task-019)
- Hygiene cleanup of 009 LOW/NIT + 010-follow + 011-follow
  (~21 items) — bundle into a small task after 012

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to `docs/tasks/012-*.PR.md`.
- `pnpm --filter @qufox/api test:int` green **on GitHub Actions**.
  New specs:
  - `attachments.int.spec.ts` (presign + finalize + download
    - idempotency + 100 MB cap)
  - `channel-acl.int.spec.ts` (private channel visibility,
    permission override apply, DENY > ALLOW invariant)
  - `attachment-acl.int.spec.ts` (private channel attachment
    download requires read access)
  - `orphan-gc.int.spec.ts` (24h tick deletes unfinalized)
- `pnpm --filter @qufox/web test:e2e` green **on GitHub Actions**:
  - `attachment-upload.e2e.ts`
  - `private-channel.e2e.ts`
  - `private-channel-attachment.e2e.ts`
- Two Prisma migrations, **reversible-first** (down scripts
  asserted by db-migrator subagent):
  - `add_attachment_table.sql`
  - `enable_channel_isprivate_and_overrides.sql`
- `EXPLAIN` captured for `GET /workspaces/:id/channels` —
  index scan, no seq scan. Recorded in 012 PR.md.
- `docker compose -f docker-compose.prod.yml config --quiet`
  green with `qufox-minio` service present.
- `bash scripts/setup/init-minio.sh --dry-run` exits 0.
- `bash scripts/backup/minio-backup.sh` manual run produces a
  snapshot under `/volume3/qufox-data/backups/qufox/minio/<date>/`.
- `bash scripts/backup/minio-restore-test.sh` green on a fresh
  snapshot.
- `bash scripts/backup/attachment-orphan-gc.sh --dry-run` lists
  candidates without deleting.
- nginx-diff updated to include the `/attachments/` location
  block; `bash scripts/setup/apply-nginx-diff.sh --dry-run`
  recognizes the new block.
- `bash scripts/deploy/test-syntax.sh` green (covers all new
  scripts).
- CLAUDE.md grep: `grep -E 'AWS|Terraform|Helm|kubernetes|
CloudWatch|Sentry|External Secrets|S3 prod' CLAUDE.md` returns
  **0 lines** (all NAS-only corrections applied).
- evals: `evals/tasks/026-attachment-presign-roundtrip.yaml`,
  `027-private-channel-acl.yaml`.
- Three artefacts: `012-*.md`, `012-*.PR.md`, `012-*.review.md`.
- Reviewer subagent **actually spawned**; transcript token count
  recorded in `012-*.review.md` header.
- **Direct merge to develop** (PR creation skipped). Commit
  message: `Merge task-012: attachments (NAS MinIO) + channel ACL
  - CLAUDE.md NAS-only`.

## Prerequisite outcomes

- 011 merged to develop (`8e747c2`).
- GHA integration + e2e workflows from 011-D running and green
  on this branch before merge.
- 002 PermissionMatrix in `apps/api/src/auth/permissions.ts`
  (workspace level) — extension base for D.
- Channel.isPrivate column reserved in 005 — confirmed by reading
  current Prisma schema before scaffolding.

## Design Decisions

### Single MinIO instance, not distributed mode

Distributed MinIO needs ≥4 drives, identical specs, careful
volume layout. The NAS has SHR/RAID at the volume level already,
so single-instance MinIO + filesystem-level redundancy is the
right shape for beta. HA migration is a future task and only
matters once attachment availability becomes a hard SLA.

### Presign-direct upload, not API proxy

API server never sees the attachment bytes. Two reasons: (1)
nginx proxy_buffering off + 100 MB body would tie up an api
worker for the upload duration; (2) MinIO is the bandwidth
specialist on this box, not Node. Tradeoff: client must
talk MinIO directly through the `/attachments/` nginx route,
so presign URL must use the public hostname (`MINIO_SERVER_URL`
env handles this).

### Permission mask is bitfield, not separate boolean columns

Eight permissions today, room for 24 more. Bitfield comparisons
are atomic; effective-mask calculation is a single int op per
check. Separate booleans would be 8 columns today and 32
tomorrow with lookup overhead. Cost: one less Prisma type-safety
helper — wrap with `permissions.ts` helpers (`hasPermission`,
`addPermission`, `removePermission`).

### `clientAttachmentId` for idempotency, not request-id

A network retry of `presign-upload` with the same params should
return the same record (and same S3 key), not duplicate the
upload slot. Driving idempotency from the client uuid (visible to
the test) is more debuggable than a server-side hash. `(channelId,
clientAttachmentId)` unique index enforces.

### Migrate `BACKUP_DIR` in this task, not a separate one

The 011 backup containers point at `/volume1/backups/qufox`, but
moving forward all data lives under `/volume3/qufox-data/`. If
this task adds MinIO backups under `/volume3` while leaving
postgres + redis on `/volume1`, operators will have two backup
roots to remember. Bundle the migration here; add the rsync
one-liner to the runbook so existing backups aren't lost.

### CLAUDE.md correction lives in the same task

Doing the AWS/K8s grep cleanup as a separate hygiene task means
some other agent might keep designing tasks against the wrong
defaults in the meantime. Take the 30-line edit now while we're
already touching the deploy story.

## Non-goals

- Attachment sharing across workspaces. Each upload is bound to a
  single workspace+channel. Cross-channel forwarding can copy
  bytes (or upload again) — no shared S3 keys.
- Attachment streaming (HTTP range request) — MinIO supports range
  GET natively; if a frontend wants seek, it just sets the audio/
  video element src to the presign URL.
- Attachment retention beyond message lifetime. CASCADE on
  message delete handles it; a separate "delete attachment but
  keep message" feature is out.

## Risks

- **NAS disk fill** — `/volume3` is 7.0 TB with ~988 GB free.
  100 MB/file × user growth could fill in months at 10 GB/day.
  Mitigation: `qufox_minio_disk_used_bytes` Prometheus gauge
  scraped from `df`; alert at 80% (`/volume3` at ~5.6 TB used);
  beta user whitelist already caps signups.
- **MinIO single-instance downtime** = attachment unavailable;
  messages still readable from Postgres. The frontend must render
  attachment cards as "loading…" with retry button rather than
  failing the whole message render. E2E asserts this fallback.
- **nginx body cap conflict** — 010 reviewer raised body cap to
  25 MB for the webhook receiver. The new `/attachments/`
  location uses a separate `client_max_body_size 100m`; nginx
  scopes `client_max_body_size` per location, so no conflict.
  Verify in `nginx -t` after diff.
- **Presign URL leak** — URL is valid for the configured TTL
  (default GET 30 min) regardless of the requester. Anyone with
  the URL can read until expiry. Mitigation: short TTL,
  re-acquire on lightbox open after 25 min; long-term solution is
  signed cookies (out of scope this task).
- **Permission mask migration** — adding override layer changes
  the effective-mask calculation for every existing route. 002 +
  003 tests must keep passing without modification (channel
  override empty == workspace role only). Add an invariant
  test asserting this.
- **Backup directory migration breaks running cron** — moving
  `BACKUP_DIR` while the 011 backup container is running on the
  old path means snapshots stop arriving silently. Mitigation:
  migration is "set new env, restart container" — operator runs
  the rsync once, then `docker compose up -d qufox-backup`. The
  runbook update is the contract.
- **MINIO_SERVER_URL must match what nginx proxies** — if
  configured wrong, presign URLs sign for `qufox-minio:9000`
  (internal) and the browser tries to hit that. Add an
  init-minio.sh smoke test that does a roundtrip presign +
  external GET.
- **CLAUDE.md edits are read by other agents mid-task** —
  edit is small (30 lines); any in-flight session will pick up
  the new defaults on next read. Document the change in the
  task report so future agents know which parts of CLAUDE.md
  were rewritten.
- **Reviewer pushback on bitfield ergonomics** — bitfield
  permissions can be unergonomic in code review (raw hex
  literals). Mitigation: ban hex literals at call sites; force
  `Permissions.READ | Permissions.WRITE_MESSAGE` style enum
  references via ESLint `no-restricted-syntax` (extends 010-C
  rule).

## Progress Log

_Implementer fills this section during UNDERSTAND → REPORT.
Eight commit groups (A through H) is the suggested split, but
implementer can merge G into B if the orphan-GC code is small._

- [ ] UNDERSTAND
- [ ] PLAN approved
- [ ] SCAFFOLD (Prisma migrations red, S3Service stubbed)
- [ ] IMPLEMENT (A → F → B → C → D → E → G → H, in dependency
      order — backups first so MinIO has a place to spill, then
      MinIO infra, then API, then web, then ACL, then GC, then
      docs)
- [ ] VERIFY (`pnpm verify` after each chunk + GHA runs green)
- [ ] OBSERVE (EXPLAIN captured, MinIO disk-used metric visible,
      orphan GC dry-run logged, attachment E2E trace uploaded)
- [ ] REFACTOR
- [ ] REPORT (PR.md written, reviewer spawned, evals added,
      direct-merge to develop with the canonical merge message)
