# Reviewer — task-037 Cleanup Sweep + Custom Emoji Pack

Branch `feat/task-037-cleanup-custom-emoji` @ `c89c39e`.

## Verdict

**Approve with fix-forward.** All five chunk A–D deliverables land;
chunk D (custom emoji) is the only area with reviewable shape. No
BLOCKERs; one HIGH worth a fix-forward, a few MEDs, a handful of LOWs.

## HIGH

1. **Finalize-vs-PUT race leaves orphan MinIO objects without GC.**
   `apps/api/src/emojis/custom-emoji.service.ts:143-148` — when
   `headObject` returns null, we `prisma.customEmoji.delete` and bail.
   But the presigned PUT (15 min TTL on the default put-url) is still
   valid, so a slow client can land bytes _after_ the row is gone. The
   Attachment orphan GC (`scripts/backup/attachment-orphan-gc.sh:61-65`)
   selects from the `"Attachment"` table only — grep for
   `CustomEmoji|emoji` in the script is **0 hits**. No sweeper exists
   for the `<wsId>/emojis/` prefix, so such orphans accumulate in MinIO
   forever. Fix-forward: either (a) extend orphan-gc with a second
   query that lists MinIO under `/emojis/` and removes objects whose
   `<emojiId>` is not in `CustomEmoji.id`, or (b) mark the row
   `finalizedAt NULL` on reservation and sweep stale reservations the
   same way Attachments do. Track as `TODO(task-037-follow-emoji-gc)`.

## MED

1. **Controller docstring claims list is rate-limited; code is not.**
   `apps/api/src/emojis/custom-emoji.controller.ts:25` says
   “list rate-limited 30/min/user” but there is no `rateLimit.enforce`
   call on the `@Get()` handler (lines 38-41). React Query staleTime
   (10 min, `useCustomEmojis.ts:11`) caps real-world hits, but a
   malicious client bypassing the cache gets unbounded presign-GET
   loads against MinIO. Either wire the enforce call or drop the
   docstring claim — current state is misleading for operators.

2. **DTO does not enum-restrict `mime`.**
   `apps/api/src/emojis/dto/presign-emoji-upload.dto.ts:7-10` — only
   length validation. Service does gate on `ALLOWED_EMOJI_MIME`
   (`custom-emoji.service.ts:71-76`), so requests fail safely, but a
   DTO-level `@IsIn(['image/png','image/gif'])` would reject before the
   transaction opens and avoid a 400→422 round-trip for the common
   typo case. NIT-leaning MED.

3. **Magic-bytes check promised in the risk register is absent.**
   Task doc lines 303-305 list a PNG/GIF header check as MIME-spoof
   mitigation; `finalize` only HEADs size. SOP + nginx
   `nosniff` make this non-exploitable for XSS on our stack, but
   either add the 4-byte check in `finalize` or update the task doc
   so the contract matches reality. Flag for accuracy.

## LOW / NIT

1. `WorkspaceEmojiManager.tsx:88-92` uses `window.confirm()`; DS
   pattern (see `WorkspaceSettingsPage` `workspace-visibility-confirm`)
   is a custom dialog. NIT per user memory
   `feedback_design_system_source_of_truth.md`.

2. `custom-emoji.service.ts:141` throws `ErrorCode.FORBIDDEN` (generic 403) for uploader-mismatch on finalize. Every other
   emoji-pack code is `CUSTOM_EMOJI_*`. A `CUSTOM_EMOJI_NOT_UPLOADER`
   (or reusing `MESSAGE_NOT_AUTHOR` pattern) would be more traceable.

3. `parseContent.tsx:89` regex `:([a-z0-9_]{2,32}):` overlaps with
   timestamps like `1:23:45` — the `:23:` token matches but falls
   through as literal text via `splitLines(m[0], ...)` on line 141.
   Verified via `parseContent.spec.tsx:80-84`. Correct as implemented;
   noting for future reviewer.

## OK

- Cap + name-unique both under Serializable tx; P2002 → `CUSTOM_EMOJI_NAME_TAKEN` (`custom-emoji.service.ts:87-121`).
- `CustomEmoji.createdBy` ON DELETE RESTRICT matches existing
  `Message.author` / `Attachment.uploader` (no explicit rule = Prisma
  default Restrict). User model has no `deletedAt`, so hard-delete
  blocked on any of these FKs — consistent, not a regression.
- `ErrorCode` ↔ `ErrorCodeSchema` parity: all six new codes present
  in `packages/shared-types/src/index.ts:115-120` + HTTP mapping in
  `error-code.enum.ts:140-145`; parity spec
  (`error-code-schema.unit.spec.ts`) would have caught drift.
- DS files (`apps/web/public/design-system/*`) diff vs develop is
  empty — memory `feedback_design_system_source_of_truth.md` honoured.
- `CustomEmojiContext` emits a stable `EMPTY` default; parser path
  for `workspaceId=null` is well-covered; no NPE surface.
- Chunk A deletion is clean: `grep '/me/workspaces/.*dms'` in
  `apps/api` / `apps/web` is 0; channels module comment at
  `channels.module.ts:10` records the removal.
- Chunk C cleanup: live `TODO(task-03[2-6]-follow...)` markers in
  code are zero; only doc/review references remain.
