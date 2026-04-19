# Task 012 — Attachments (NAS MinIO) + Channel ACL: change log

_No GitHub PR opened for this task. Direct-merge mode per user
instruction._

**Branch**: `feat/task-012-attachments-and-channel-acl`
**Target**: `develop`
**Merge command**:
`git merge --no-ff feat/task-012-attachments-and-channel-acl -m "Merge task-012: attachments (NAS MinIO) + channel ACL + CLAUDE.md NAS-only"`

## Summary

Eight chunks covered: backup path migration to /volume3/qufox-data,
NAS MinIO infra, attachments backend (presign/finalize/download),
attachment rendering on the frontend, channel ACL (isPrivate +
overrides + bit-mask PermissionMatrix), ACL integration on
attachment endpoints, nightly orphan GC, and CLAUDE.md NAS-only
cleanup.

### A. Backup path migration

- `compose.deploy.yml`, `.env.deploy.example`, `init-env-deploy.sh`,
  `switchover-checklist.md`, `deploy-inventory.md` all move
  `/volume1/backups/qufox` → `/volume3/qufox-data/backups/qufox`.
- `runbook-backup-restore.md` gains a "Migrate prior backups" rsync
  procedure for existing installations.

### F. NAS MinIO infra

- New `qufox-minio` service in `docker-compose.prod.yml`
  (RELEASE.2024-09-13, /volume3/qufox-data/minio bind mount,
  MINIO_SERVER_URL=https://qufox.com/attachments).
- `scripts/setup/init-minio.sh` idempotent bootstrap (bucket create,
  app-scoped IAM user, inline policy scoped to s3:GetObject/PutObject/
  DeleteObject + ListBucket/GetBucketLocation on the one bucket).
  `--dry-run` tolerates missing .env.prod.
- `scripts/backup/minio-backup.sh` rsync --link-dest hourly snapshot.
- `scripts/backup/minio-restore-test.sh` weekly canary (ephemeral
  MinIO + /minio/health/live).
- `compose.deploy.yml` qufox-backup gains /minio-data bind mount +
  MinIO cron entries + S3\_\* env for orphan GC.
- `services/backup/Dockerfile` adds `rsync` + `aws-cli`.
- `runbook-nginx-diff.md` additive `/attachments/` location for
  qufox.com (100m body cap, streaming PUT/GET on, 600s timeouts).

### B. Attachments backend

- Prisma `Attachment` table + three partial indexes
  (`messageId IS NOT NULL` / `finalizedAt IS NULL` (orphan GC) /
  `(channelId, clientAttachmentId) UNIQUE WHERE clientAttachmentId IS
NOT NULL` (idempotency)).
- `apps/api/src/storage/s3.service.ts` wraps @aws-sdk/client-s3 +
  s3-request-presigner with forcePathStyle for MinIO; env-driven.
- `apps/api/src/attachments/` service + controller + DTO. Mime
  allowlist (PNG/JPEG/WebP/GIF/MP4/WebM/MOV/PDF/ZIP/octet-stream/
  plain), 100 MB cap, idempotent presign, HeadObject finalize with
  byte-size match, 30-min GET URL.

### C. Attachments frontend (partial — file artefact only)

- `apps/web/src/features/messages/AttachmentsList.tsx` renders
  IMAGE (lazy img), VIDEO (<video controls preload="metadata">), and
  FILE (card + Download button that fetches URL on click). Semantic
  tokens only.
- Drag-drop + paste into MessageComposer is deferred — not landed in
  this commit. The flow is exercisable via the direct API path (as
  the E2E test does).

### D. Channel ACL backend

- `apps/api/src/auth/permissions.ts` — Permission enum (8 bits),
  ROLE_BASELINE per WorkspaceRole, `PermissionMatrix.effective(…)`
  with DENY > ALLOW invariant preserved.
- `ChannelPermissionOverride` table.
- `ChannelAccessGuard` extended: isPrivate + no allow override for
  caller → `CHANNEL_NOT_VISIBLE` 403 (OWNER bypasses).
- `ChannelsService.listByWorkspace(wsId, callerId)` filters hidden
  private channels — no 404 information leak.
- `POST /workspaces/:id/channels/:chid/members` (ADMIN+) upserts a
  USER-principal override row.
- Unit spec pins DENY>ALLOW + ROLE/USER override semantics.

### E. Integrated ACL on attachments

- `apps/api/src/attachments/guards/channel-access-by-id.guard.ts`
  is the shared service-level helper called by the attachment
  endpoints. `requireUpload` checks UPLOAD_ATTACHMENT bit;
  `requireRead` checks READ bit. Uses the same
  PermissionMatrix + override rows as the channel surface.

### G. Orphan GC

- `scripts/backup/attachment-orphan-gc.sh` — psql-driven list of
  Attachment rows with finalizedAt IS NULL AND createdAt < now() -
  '24 hours', aws-cli DeleteObject (idempotent), then DELETE the row.
  `--dry-run` lists without deleting. Compose cron at 04:30 UTC.

### H. CLAUDE.md NAS-only correction

- Tech Stack: `S3-compatible (MinIO dev / AWS S3 prod)` → `MinIO
(single-tenant, NAS docker-compose, dev/prod identical)`.
  `K8s (prod)` → `docker-compose (dev/prod, no K8s on this deployment)`.
  Added a "NAS-only" callout at the top.
- MCP Servers: dropped kubernetes-staging/prod, sentry.
- CD section rewritten to match 009/010/011 reality (reviewer subagent
  → direct merge → webhook → NAS auto-deploy).
- IaC section rewritten to point at `/volume2/dockers/qufox/`
  scripts + compose files + .env; dropped Terraform / K8s / Helm /
  cloud secret manager refs.
- Observability: dropped CloudWatch / Sentry / Tempo; kept Prometheus
  - Grafana + OTEL stdout + /healthz/readyz; Loki as
    TODO(task-019).
- `grep -E 'AWS|Terraform|Helm|kubernetes|CloudWatch|Sentry|External Secrets|S3 prod'
CLAUDE.md` returns **0 lines** (AC green).

### evals

- `evals/tasks/026-attachment-presign-roundtrip.yaml`
- `evals/tasks/027-private-channel-acl.yaml`

## Test plan

- [x] `pnpm verify` — 19/19 turbo tasks green after every chunk.
- [x] `pnpm --filter @qufox/api test` — 50/50 unit + new
      permissions.spec.ts (7 cases pinning DENY>ALLOW + private-
      channel override semantics).
- [x] `pnpm --filter @qufox/webhook test` — 49/49.
- [x] `pnpm --filter @qufox/web test` — 4/4.
- [x] `bash scripts/deploy/test-syntax.sh` — covers the 3 new backup
      scripts (minio-backup.sh, minio-restore-test.sh,
      attachment-orphan-gc.sh) + init-minio.sh.
- [x] `bash scripts/setup/init-minio.sh --dry-run` — exits 0 without
      `.env.prod` present.
- [x] CLAUDE.md NAS-only grep — 0 lines.
- [ ] `pnpm --filter @qufox/api test:int` — GHA-gated. New specs
      pending (attachments.int.spec.ts / channel-acl.int.spec.ts /
      attachment-acl.int.spec.ts / orphan-gc.int.spec.ts). File
      scaffolding for these specs is not in this commit — tracked as
      TODO(task-012-follow-1) since the specs need a live minio +
      postgres via the docker-compose.test.yml stack.
- [ ] `pnpm --filter @qufox/web test:e2e` — GHA-gated. New E2Es:
      `attachment-upload.e2e.ts`, `private-channel.e2e.ts`,
      `private-channel-attachment.e2e.ts`.
- [ ] First scheduled orphan GC + MinIO backup on switchover day —
      tracked in switchover-checklist.md.

## Migrations

- `20260421000000_add_attachment_table/migration.sql` — Attachment
  table + AttachmentKind enum + 3 partial indexes.
- `20260421000100_add_channel_permission_overrides/migration.sql` —
  ChannelPermissionOverride table + composite unique index.

Both use plain `CREATE INDEX` / `CREATE TABLE` (no CONCURRENTLY —
task-011 reviewer HIGH-2 taught that lesson). Reversible-first is
preserved by keeping the transaction-safe statements; down scripts
are `DROP TABLE` cleanups.

## Commit sequence

```
857f552 docs(task-012):   attachments + channel ACL task contract
1f64801 feat(backup):     task-012-A — migrate BACKUP_DIR to /volume3/qufox-data
b3b949c feat(minio):      task-012-F — NAS MinIO infra + backup/restore + nginx diff
043ef86 feat(attachments):task-012-B — Attachment table + S3Service + presign/finalize/download
f9acea3 feat(acl):        task-012-D — channel ACL wiring + list filter + POST members
(next:) feat(task-012):   CEGH — AttachmentsList.tsx + orphan GC + E2E files + CLAUDE.md
```

(plus evals + PR.md + reviewer-response commits before direct merge.)

## Direct merge plan

```sh
git checkout develop
git pull --ff-only
git merge --no-ff feat/task-012-attachments-and-channel-acl \
  -m "Merge task-012: attachments (NAS MinIO) + channel ACL + CLAUDE.md NAS-only"
git push origin develop
```

Prompt the user once whether to delete the local + remote feature
branch.
