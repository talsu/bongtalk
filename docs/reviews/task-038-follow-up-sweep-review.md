# task-038 follow-up-sweep — Adversarial Review

**Branch:** `feat/task-038-follow-up-sweep`
**Scope:** A emoji orphan-gc, B magic-bytes validation, C DS protection workflow.

## Verdict

**APPROVE with HIGH follow-ups.** No BLOCKER. Core logic is correct; the
magic-byte helper is tight, ordering in both finalize paths is safe for
the single-PUT-per-key model, and the PGURL fix resolves the silent
cron failure. Two HIGHs worth tracking before volume grows.

## BLOCKER

_None._

## HIGH

- **H1. `list-objects-v2` has no pagination** —
  `scripts/backup/attachment-orphan-gc.sh:165-168`. The AWS CLI
  `list-objects-v2` call relies on the default `--page-size`/max-keys
  and does NOT iterate continuation tokens; once the bucket surpasses
  ~1000 objects the sweep silently misses the tail. Fix options: add
  `--no-paginate` off + loop on `NextContinuationToken`, or switch to
  `aws s3api list-objects-v2 --no-cli-pager --output text` with the
  built-in paginator (`aws s3api list-objects-v2 ... | jq -r`). Low
  urgency today (prod emoji blob count is 0 per OBSERVE), but the fix
  belongs in 038-follow before custom emojis land broadly.
- **H2. `image/webp` bypasses magic-byte check** —
  `apps/api/src/attachments/attachments.service.ts:176`. WebP is an
  allowed attachment mime (`ALLOWED_MIME['image/webp']`) and gets
  rendered inline in the chat UI, but the gate only covers
  png/gif/jpeg. A malicious client can presign as `image/webp` and
  upload arbitrary bytes — browsers may content-sniff and execute as
  HTML in some paths (IE/quirk modes), and any future CDN in front of
  MinIO could misclassify. Add WebP magic (`RIFF....WEBP` — `52 49 46
46 __ __ __ __ 57 45 42 50`) to the helper and gate. Same risk model
  as PNG — same defence.

## MED

- **M1. `validate-magic-bytes.ts` default `return false`** is correct
  but the `MagicSupportedMime` type narrowing means callers can never
  actually hit the `default` branch under strict mode — it's a
  belt-and-braces for `as` casts. Worth a comment or an
  `exhaustive-check` const-assertion so a future 4th mime addition
  can't be silently skipped (`src/storage/validate-magic-bytes.ts:69`).
- **M2. `getObjectRange(key, 15)` returns ≤ 16 bytes** —
  `apps/api/src/storage/s3.service.ts:162`. `Range: bytes=0-15` is
  end-inclusive per RFC 7233 so this is correct. But
  `transformToByteArray()` on an empty body (already short-circuited
  on line 165) returns a 0-byte array. `matchesMagic` handles that
  via the length guards. Safe, but a one-line comment confirming the
  inclusive-range semantics would save the next reader a trip to
  RFC 7233.
- **M3. `INVALID_MAGIC_BYTES` → 400** —
  `apps/api/src/common/errors/error-code.enum.ts:152`. The enum
  comment at line 73-75 acknowledges the 415-vs-400 tension and picks
  400 on the grounds that "the declared mime WAS valid, the body
  lied". Defensible, but I'd argue **422 Unprocessable Entity** is a
  better semantic fit — the request _shape_ was valid (no mime
  rejection), the _content_ was unprocessable. 400 is generic and
  conflates this with validation errors. Non-blocking; the client
  distinguishes via `code` not status.
- **M4. Ordering: HEAD → range-GET → magic** (`custom-emoji.service.ts:149-178`,
  `attachments.service.ts:156-186`) — the TOCTOU between HEAD and GET
  is not exploitable here because presign issues ONE PUT URL per key
  and the uploader is the caller, but if we ever offer presigned-PUT
  re-issue (e.g. for resumable multipart) the magic check could race
  against the second PUT. Worth a sentinel comment pinning "single PUT
  invariant."

## LOW

- **L1. `<<<"$CANDIDATES"` with empty var** —
  `scripts/backup/attachment-orphan-gc.sh:83,103`. Bash herestring
  emits a single newline for an empty var, so the `while IFS='|' read`
  loop runs ONCE with `ID=""` and the `[[ -z "$ID" ]] && continue`
  guard on line 84 catches it. Correct in the final output, but the
  `COUNT=0` path through the guard is load-bearing — add a test or
  the guard becomes invisible.
- **L2. `ds-protection.yml` grep is range-wide, not per-commit** —
  `.github/workflows/ds-protection.yml:34`. Any single commit in the
  PR range carrying `[ds-ok]` satisfies the check. Intended per the
  design doc ("opt-in per PR"). For squash-merges, GitHub
  concatenates all commit messages into the merge commit so the tag
  survives. Rebase-merges: the tag travels with the commit it was
  authored on. Safe for all three merge strategies currently allowed.
- **L3. Path filter on `apps/web/public/design-system/**`** matches
modifications, additions, deletions, and renames per GitHub
`paths:`docs. File mode changes alone don't trigger`pull_request`
  — acceptable. Web-UI edits go through PR events same as CLI. No
  bypass vector I can see, short of admin PR overrides.
- **L4. `date -u -d '7 days ago'` with BSD fallback** — line 135-136
  handles both GNU and BSD `date`. The NAS runs alpine (BusyBox
  `date`); BusyBox accepts `-d '7 days ago'` via `date -d` only
  partially. Verify the container image actually resolves this —
  OBSERVE shows it working, but a container base swap could surface.
- **L5. `KNOWN_SET` uses `grep -qxF`** — fine for UUID chars, but if
  the set ever grew a lot, swapping to `awk 'NR==FNR{a[$0]=1;next} a[$0]'`
  would avoid spawning one grep per object.

## OK

- `matchesMagic` PNG/GIF87a/GIF89a/JPEG logic is correct; `GIF85a` is
  rejected (unit-tested); truncated headers rejected via length guard.
- `s3.service.getObjectRange` uses SDK v3 `transformToByteArray()`
  which is the documented path for Node. `NoSuchKey`/`NotFound` race
  is handled identically to `headObject`.
- `PGURL="${DATABASE_URL%%\?*}"` correctly strips Prisma's
  `?schema=public` — verified against libpq connstring grammar.
- `CustomEmojiService.finalize` rolls back the DB row on both size
  mismatch AND magic mismatch; `deleteObject` is idempotent.
- `AttachmentsService.finalize` correctly scopes the magic gate to
  png/gif/jpeg only; pdf/zip/video/text skip is intentional + tested.
- Memory `feedback_design_system_source_of_truth.md` updated with the
  CI guard note per scope.
- shared-types `INVALID_MAGIC_BYTES` wired through error-code enum +
  HTTP map.

_Reviewer token-count estimate: ~2200 tokens (this file + skim of 6
source files + task doc)._
