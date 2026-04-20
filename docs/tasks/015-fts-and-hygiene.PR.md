# Task 015 PR — Full-Text Search (pg_trgm + tsvector) + Priority Hygiene

**Branch:** `feat/task-015-fts-and-hygiene`
**Base:** `develop` (`9d1cc10`)
**Merge style:** direct `git merge --no-ff` to develop (011/012/013/014 convention)
**Memory:** `feedback_skip_pr_direct_merge.md`, `feedback_retain_feature_branches.md`, `feedback_handoff_must_include_report.md`, `feedback_minio_naming.md`

## Summary

- **A** — 8 priority hygiene items landed:
  - `ErrorCodeSchema` drift closed; shared-types now carries the 8 codes (`ATTACHMENT_*`, `CHANNEL_NOT_VISIBLE`, `FORBIDDEN`, `INVITE_REVOKED`) the backend had unmirrored. New `error-code-schema.unit.spec.ts` parity guard. (014-follow-3)
  - Reply-throttle code comment aligned with actual behaviour (014-follow-2)
  - `apply-nginx-diff.sh` pre-checks for outer `http { }` wrapper and bails with a remediation message; operator override via `ALLOW_HTTP_WRAPPER=1`. (012-follow-4)
  - `attachment-orphan-gc.sh` preamble documents the intentionally-convergent two-step delete ordering. (012-follow-5)
  - `runbook-backup-restore.md` adds the `/volume1 → /volume3` migration rsync section. (012-follow-10)
  - `unread-propagation.e2e.ts` now sends `@<username>` text (the real syntax the server extracts) instead of the bogus `everyone: true` client-sent `mentions` payload. (011-follow-8)
  - ESLint palette rule gains a `TemplateElement` selector so `` `bg-slate-${shade}` `` is caught alongside plain `"bg-slate-900"`. (010-follow-5)
  - Webhook server dedupes GitHub "Redeliver" retries by `X-GitHub-Delivery` id (bounded 64-entry LRU); spec asserts a single enqueue across two identical deliveries. (009-nit-3)
- **B** — FTS backend:
  - Migration `20260424000000` adds `pg_trgm`, a generated `search_tsv` tsvector column (STORED), and two partial GIN indexes (`search_tsv`, `content gin_trgm_ops`) both `WHERE "deletedAt" IS NULL`. `CONCURRENTLY` deferred to a deploy-time hook on populated prod DBs.
  - `SearchService` SELECTs with a LATERAL OR: `search_tsv @@ plainto_tsquery('simple', q)` covers English; `content ILIKE '%q%'` covers Korean substring via the pg_trgm index. `ts_rank` orders, `ts_headline` emits `<mark>…</mark>` AFTER the content is HTML-escaped via three `replace()` passes so the wire payload only ever contains mark tags.
  - ACL uses `ChannelAccessService.resolveEffective` (task-014-A single entry point) to build `visibleChannelIds` — the query filters by `channelId = ANY(...)` so hidden channels never enter the planner's scope.
  - Opaque cursor `base64url(JSON({rank, createdAt, id}))` matches the ORDER BY tuple for stable keyset pagination.
  - `GET /search?q=&workspaceId=&channelId?&cursor?&limit=` with 30 req/min per-user rate limit.
  - shared-types: `SearchResultSchema` + `SearchResponseSchema`.
- **C** — FTS frontend:
  - `Ctrl+/` opens a new `SearchOverlay` (Dialog-based, like CommandPalette). Shortcut-help moved to plain `?`; BottomBar tooltip and ShortcutHelp combo list updated.
  - 300ms debounce on the input, empty state renders up to 5 recent searches from localStorage (PII stays on device).
  - Result snippet renders through `markOnlyHtml`, a whitelist sanitizer that escapes every angle bracket then restores only `<mark>` / `</mark>`. No DOMPurify dep. Unit-tested for script injection + double-escape.
  - Result click navigates to `/w/:slug/:channelName?msg=<id>` (reuses 011 mention-jump).
  - `SearchService` pairs with the sanitizer to give defense-in-depth: server escapes → sanitizer restricts to marks.
  - E2E `search.e2e.ts` verifies Ctrl+/ trigger, result highlighting, and the private-channel exclusion for non-members.

## Verify

```
pnpm verify → green
```

Tasks: 19/19 success, 0 errors.

- `@qufox/api:typecheck` ✓
- `@qufox/api:test` ✓ (+ new `error-code-schema.unit.spec.ts`, 2 tests)
- `@qufox/webhook:test` ✓ (13 server tests, +1 for redelivery dedupe)
- `@qufox/shared-types:test` ✓
- `@qufox/web:test` ✓ (+ new `sanitize.spec.ts`, 4 tests)
- `@qufox/web:typecheck` ✓

## New int specs (GHA)

- `apps/api/test/int/search/search.int.spec.ts` — missing-q rejection, English tsvector hit, Korean pg_trgm substring, ACL (outsider 0 results + private-channel excluded for non-member), XSS-safe snippet (`<script>` → `&lt;script&gt;`), soft-delete exclusion, EXPLAIN asserting no Seq Scan on Message.

## Migration

`apps/api/prisma/migrations/20260424000000_add_message_search/` — additive. Dev/test `migrate deploy` uses plain `CREATE INDEX` (empty / tiny tables). Production rollout runs a separate deploy-hook SQL with `CREATE INDEX CONCURRENTLY` to avoid AccessExclusive on `Message` — that script is a follow-up (015-follow-N) when the next deploy pass needs it.

Down-migration drops indexes + column; leaves `pg_trgm` extension in place for future features.

## Commits

```
73cf051 feat(search): task-015-C — SearchOverlay with Ctrl+/ trigger + recent searches
4bd8ac8 feat(search): task-015-B — message FTS via pg_trgm + tsvector
5fc0362 refactor(hygiene): task-015-A — priority cleanup (8 items)
75e3290 docs(task-015): FTS + priority hygiene task contract
```

## Acceptance greps

- 0 lines for the 8 `TODO(task-…)` markers listed in the contract (verified after each chunk; all were doc-only and remain doc-only).
- `ErrorCode` enum parity with `ErrorCodeSchema` locked in via the new `error-code-schema.unit.spec.ts`.

## Risks

- Korean trigram precision is approximate (substring matching, no morphological analysis). Acceptable for beta; real analyzer slot documented in the task contract.
- `search_tsv` generated column costs single-digit% on Message INSERT. Monitor via `pg_stat_user_tables` in the future; well within budget at beta volume.
- `SearchOverlay` doesn't yet prefetch per-channel visibility, so the first search on a large-channel workspace runs N ChannelAccessService fetches. Fold to a single SQL aggregate when channel counts grow past ~50 (noted as a follow-up below).
