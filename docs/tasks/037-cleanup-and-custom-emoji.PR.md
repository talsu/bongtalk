## Summary

Pre-beta cleanup sweep + the first "small but fun" feature. Four backend
concerns close at once; one frontend surface (message + picker + settings)
gains a workspace custom-emoji pack. No DS primitive changes.

## Chunks landed

- **A (`4682e22`)** — 027 deprecated workspace-scoped DM endpoints removed.
  `DirectMessagesController` deleted; `GlobalDmController` at `/me/dms` is
  the sole DM surface. `useDms.ts` migrated call sites. Grep evidence:
  `/me/workspaces/.*dms` → **0 hits** across `apps/api` + `apps/web` +
  `services`. DIRECT channel rows with non-null `workspaceId` are
  preserved intentionally (history continuity; future purge task).
- **B (`7e634ad`)** — 036 TODO-loki-ruler closed. Loki 2.9.8 Ruler
  enabled with local storage, `/etc/loki-rules/fake/qufox.yml` holds the
  `LokiHighErrorRate` LogQL rule (`sum(rate({level="error"}[5m])) > 10`
  for 5m). No Alertmanager yet — rule evaluates + surfaces via
  `/loki/api/v1/rules`, delivery wire-up is a separate task.
- **C (`4c9d43f`)** — cleanup commits against LOW/NIT markers:
  - `fix(cleanup-032-follow-cap-atomicity)` — friendship cap counted +
    inserted inside a single Serializable transaction. Concurrent
    requests can no longer both pass the count check and push the
    workspace past 1000.
  - `fix(cleanup-032-follow-block-flip-p2002)` — block/unblock toggle
    catches P2002 on the unique (requester, addressee) and falls back
    to UPDATE. Previously surfaced as a 500.
  - Stale 033 marker in `direct-messages.service.ts` JSDoc retired
    (workspaceId nullable already lives in the schema post-034).
- **D (`c89c39e`)** — workspace custom emoji pack. Full details below.
- **E** — develop → main auto-promote + Pane 1 auto-forward (pending).

## Chunk D details (the big one)

- **Schema** — `CustomEmoji(id, workspaceId, name, createdBy, storageKey,
mime, sizeBytes, createdAt)` with `@@unique(workspaceId, name)` and an
  index on `workspaceId`. ON DELETE CASCADE from Workspace, RESTRICT on
  createdBy (matches the Attachment FK policy — uploads outlive a user
  soft-delete by design).
- **API** (`/workspaces/:wsId/emojis`):
  - `GET /` — any member can list. Returns items with a presigned GET URL
    (30-min TTL). React Query cache has 10-min staleTime.
  - `POST /presign-upload` — OWNER/ADMIN, 10/min per (workspace, user).
    Validates `name` against `[a-z0-9_]{2,32}`, mime in `{png, gif}`,
    sizeBytes ≤ 256 KB. Counts the workspace's emoji rows inside a
    Serializable transaction and rejects if the insert would exceed 100
    — same TOCTOU fix pattern Chunk C applied to friends.
  - `POST /:id/finalize` — OWNER/ADMIN. HEAD-object the landed blob; if
    the size doesn't match, delete the row + object and raise
    `CUSTOM_EMOJI_TOO_LARGE`.
  - `DELETE /:id` — OWNER/ADMIN, 30/min per user. Removes the row + the
    S3 object (idempotent on missing key).
- **Storage** — `qufox-attachments/<wsId>/emojis/<emojiId>-<safeFilename>`.
  Same bucket as attachments → one lifecycle policy.
- **UI**:
  - `EmojiPicker` gains a "워크스페이스" tab (first when the pack is
    non-empty). Picker returns a string — Unicode glyph or `:name:`
    shortcode — and the caller (ReactionBar / Composer) handles either
    form unchanged.
  - `renderMessageContent` gets a fourth rule: `:name:` → inline
    `<img class="qf-emoji-custom" style="…">` when the workspace
    defines the emoji; unknown names fall through as literal text so
    deleting an emoji doesn't break old messages.
  - `CustomEmojiProvider` wraps `MessageList` so the pack is loaded once
    per workspace render tree (not per-message).
  - `WorkspaceSettingsPage` gains an "이모지 관리" tab (OWNER/ADMIN).
    Drag-drop + file-picker upload, 96-px grid cards with delete
    (confirm via `window.confirm` — noted as NIT; DS confirm-dialog
    primitive adoption is a separate follow-up).
- **Styling** — every size is inline (`width/height: 20px` text, `40px`
  picker). DS `tokens.css` / `components.css` / `mobile.css` / `icons.css`
  `git diff` is **empty**. `qf-emoji-custom` is a className hook for
  tests, not a new CSS rule.

## Testing

- Unit: `apps/api/test/unit/emojis/custom-emoji.service.spec.ts` (7
  tests — cap, name regex, mime/size rejection, P2002 → NAME_TAKEN
  translation, success path).
- Parser: `apps/web/src/features/messages/parseContent.spec.tsx` gains
  two cases (known substitution, unknown fallthrough).
- `pnpm --filter @qufox/api test` → 64 passing. `pnpm --filter @qufox/web
test` → 36 passing. Both typechecks clean.

## Out-of-scope (explicit carryover)

- Magic-byte mime verification in `finalize` (currently trusts the
  declared mime at presign time). Follow-up task if beta traffic shows
  the mime-declare trick getting abused.
- Orphan GC sweep over `<wsId>/emojis/` prefix. Existing `orphan-gc.sh`
  targets the attachments prefix; a second pass for emojis is TODO.
- Alertmanager delivery for the new Loki rule.
- Animated APNG / lottie emoji, cross-workspace sharing, virtualization
  of the picker grid — all OUT per the task contract.

## Branches

Feature branch retained per memory. Webhook triggers on main push.
