## Summary

037 follow-up sweep. Three chunks, zero new features — close carryover
debt and automate the DS-protection rule memory has been asking for.

## Chunks

### A — orphan-gc emoji sweep (`scripts/backup/attachment-orphan-gc.sh`)

- Added a second pass after the attachment sweep that lists every
  MinIO object under any `*/emojis/` path. Any object whose emojiId
  segment (`<emojiId>-<filename>`) is absent from `CustomEmoji.id` and
  whose `LastModified` is older than 7 days is deleted. The 7-day
  grace covers the "presigned PUT still valid after row delete"
  race that task-037 reviewer HIGH-1 flagged.
- `--dry-run` / `--apply` split preserved.
- Fixed a latent bug while we were here: `DATABASE_URL` from Prisma
  carries `?schema=public` which libpq rejects. Every psql call now
  uses `PGURL="${DATABASE_URL%%\?*}"`. The attachment sweep cron at
  04:30 UTC has been silently failing on this line since first deploy
  — now green.
- Verified inside `qufox-backup` container against real prod env:
  ```
  [orphan-gc] no attachment orphans
  [orphan-gc] dry-run: 0 orphan(s) would be deleted
  [orphan-gc] emoji-orphan-gc: begin prefix=emojis/
  [orphan-gc] emoji dry-run: scanned=0 would-delete=0 prefix=emojis/
  ```

### B — magic-byte validation on finalize

- New helper `apps/api/src/storage/validate-magic-bytes.ts` exposing
  `matchesMagic(head: Uint8Array, mime)` for png/gif/jpeg. GIF accepts
  both GIF87a and GIF89a variants; PNG/JPEG are straight prefix
  compares. APNG passes (shares PNG magic — acceptable).
- `S3Service.getObjectRange(key, end)` — one range GET (`bytes=0-15`)
  using `GetObjectCommand`. Returns a `Uint8Array` via
  `transformToByteArray()` or null on NotFound/NoSuchKey.
- `CustomEmojiService.finalize` — after the existing size check,
  fetches the first 16 bytes; mismatch against declared mime =
  `s3.deleteObject()` + `prisma.customEmoji.delete()` + raise
  `INVALID_MAGIC_BYTES` (new error code, 400). Object never serves.
- `AttachmentService.finalize` — same check for image/png|gif|jpeg.
  Non-image mimes (application/pdf, application/zip, video/_, text/_)
  skip the check because they are force-downloaded, not auto-rendered.
- `ErrorCode.INVALID_MAGIC_BYTES` added to both the backend enum and
  `shared-types/src/index.ts ErrorCodeSchema`; parity spec still
  green.

### C — DS protection workflow

- New `.github/workflows/ds-protection.yml` — triggers on PRs that
  touch `apps/web/public/design-system/**`. Job fetches the base
  branch and greps the commit message range for literal `[ds-ok]`;
  missing → exit 1. The message explicitly points operators at memory
  `feedback_design_system_source_of_truth.md`.
- Local simulation confirmed both branches:
  - DS-touching commit without `[ds-ok]` → FAIL (expected).
  - DS-touching commit with `[ds-ok]` → PASS (expected).
- Memory `feedback_design_system_source_of_truth.md` gained a one-line
  note linking to the workflow path + how to opt in.
- DS diff `git diff e6ee320..HEAD -- apps/web/public/design-system/`
  is empty across all 4 files — the 037→038 window was untouched.

## Testing

- `apps/api/test/unit/storage/validate-magic-bytes.spec.ts` — 8
  tests (accept + mismatch + truncated + invalid GIF variant).
- `apps/api/test/int/emojis/magic-bytes-emoji.int.spec.ts` — 2 cases
  (PNG-as-GIF rejected + row+object deleted; real PNG accepted).
- `apps/api/test/int/attachments/magic-bytes-attachment.int.spec.ts`
  — 3 cases (text-as-JPEG rejected + row+object deleted; real JPEG
  accepted; application/pdf skips magic check and finalizes).

`pnpm --filter @qufox/api test` → 79 passing. `pnpm --filter @qufox/api
test:int magic-bytes` → 5 passing (30s, testcontainer postgres + mocked
S3Service — the storage SDK is isolated behind S3Service so stubbing
it at the Nest DI layer is the correct integration surface; no MinIO
testcontainer needed). Typecheck clean. `shared-types` + `web` tests
unchanged at 8 + 38.

## Out-of-scope / deferred

- `qufox_orphan_gc_emoji_deleted_total` metric — 012 attachment metric
  plumbing is not wired via prom-client in the backup container; a
  lift for a separate task.
- Magic check coverage for image/webp (not in 012's allowed mime list,
  so no current path reaches finalize with webp; worth revisiting if
  the mime list widens).
- Alertmanager delivery for the 036-added Loki rule still pending.

## Branches

Feature branch `feat/task-038-follow-up-sweep` retained per memory.
Migration-free — straight roll deploy once merged to main.
