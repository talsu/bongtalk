# Task 015 — Full-Text Search (Postgres pg_trgm) + Priority Hygiene Cleanup

## Context

Mention(011) / Reactions(013) / Threads(014) shipped, so the message
system is feature-complete on the user-visible side except for one
gap: there is no search. Beta users can't find "what someone said
yesterday." Task 015 adds FTS using only Postgres's bundled
`pg_trgm` contrib (no external extension to install) and, in the
same pass, cleans the priority hygiene items left by 014 — most
notably the `ErrorCodeSchema` drift between backend enum and
shared-types.

Korean tokenization is good enough with trigram for the beta
volume. A real morphological analyzer (mecab-ko, jieba) is a
later task once we have traffic to justify the operational
overhead.

## Scope (IN)

### A. Priority hygiene (8 items)

UNDERSTAND step grep-verifies each TODO marker before treating
it as work. Items already fix-forward'd get only a review.md
status update; live ones get a 1-line fix plus the marker
removed.

| Item                                                                                                                                                                                                                                             | Source        | Priority            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------- |
| `ErrorCodeSchema` (shared-types) drift — backend enum has `ATTACHMENT_*`, `CHANNEL_NOT_VISIBLE`, `FORBIDDEN`, `INVITE_REVOKED`, `MESSAGE_THREAD_DEPTH_EXCEEDED`, `MESSAGE_PARENT_NOT_FOUND` not present in the shared schema → add + unit-assert | 014-follow-3  | HIGH (UX)           |
| Reply-throttle code comment says "5/min" but actual behaviour reuses MentionThrottle (5/sec) — comment fix                                                                                                                                       | 014-follow-2  | LOW                 |
| `apply-nginx-diff.sh` include-pattern handling — the NAS nginx.conf is an include structure; EOF append needs verification                                                                                                                       | 012-follow-4  | MED (ops)           |
| `attachment-orphan-gc.sh` ordering — make `DELETE row → DELETE S3 object` atomic (or document the recovery if half completes)                                                                                                                    | 012-follow-5  | MED (correctness)   |
| `runbook-backup-restore.md` — add the `/volume1/backups/qufox` → `/volume3/qufox-data/backups/qufox` migration rsync line (012 said "operator runs once")                                                                                        | 012-follow-10 | LOW (doc)           |
| Mention E2E payload uses `everyone: true` — rewrite to use the real `users: [memberId]` shape so the test name matches what it covers                                                                                                            | 011-follow-8  | LOW (test fidelity) |
| `TemplateElement`-aware selector for the palette ESLint rule (010-C), or document the interpolation blind spot explicitly                                                                                                                        | 010-follow-5  | LOW (lint)          |
| Webhook duplicate-delivery idempotency spec — assert that GitHub redelivery of the same `delivery-id` yields a single deploy run                                                                                                                 | 009-nit-3     | NIT                 |

### B. FTS backend (closes TODO(task-025))

- Prisma migration adds a generated tsvector column on `Message`:

  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  ALTER TABLE messages ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(content, ''))
    ) STORED;
  ```

  Two indexes (built `CONCURRENTLY` outside the transaction in a
  raw SQL appendix to the migration, same pattern 014 used):

  ```sql
  CREATE INDEX CONCURRENTLY messages_search_tsv_idx
    ON messages USING gin(search_tsv)
    WHERE deleted_at IS NULL;

  CREATE INDEX CONCURRENTLY messages_content_trgm_idx
    ON messages USING gin(content gin_trgm_ops)
    WHERE deleted_at IS NULL;
  ```

  `pg_trgm` ships with Postgres 16 contrib — no extra install on
  the NAS Postgres container.

- Search query (single SQL, OR of two paths):

  ```sql
  SELECT
    m.id, m.channel_id, m.sender_id, m.created_at,
    ts_headline('simple', m.content,
                plainto_tsquery('simple', :q),
                'StartSel=<mark>,StopSel=</mark>,MaxWords=18') AS snippet,
    ts_rank(m.search_tsv, plainto_tsquery('simple', :q)) AS rank
  FROM messages m
  WHERE m.workspace_id = :wsId
    AND m.deleted_at IS NULL
    AND m.channel_id = ANY(:visibleChannelIds)
    AND (
      m.search_tsv @@ plainto_tsquery('simple', :q)
      OR m.content ILIKE '%' || :q || '%'   -- pg_trgm covers Korean substring
    )
  ORDER BY rank DESC, m.created_at DESC
  LIMIT :limit + 1
  ```

  Cursor: `(rank, created_at, id)` triple — pagination stable
  across re-queries with the same `q`.

- API endpoint:

  - `GET /search?q=&workspaceId=&channelId?&cursor?&limit=20`
  - ACL: `visibleChannelIds` computed from `ChannelAccessService`
    (014-A introduced single source). Channel `READ` mask required.
  - Optional `channelId` filter narrows further.
  - Response shape:
    ```ts
    {
      results: Array<{
        messageId: string;
        channelId: string;
        channelName: string;
        senderId: string;
        senderName: string;
        createdAt: string;
        snippet: string; // contains <mark> tags
        rank: number;
      }>;
      nextCursor: string | null;
    }
    ```
  - Rate limit: 30 requests / minute per user. Exceeds → 429.

- Defense-in-depth: query already filters by `visibleChannelIds`,
  but on response build call `ChannelAccessService.requireRead`
  per result row anyway. Permission may have flipped between
  query and response; in-memory mask check is cheap.

- Snippet contains `<mark>` HTML; the frontend renders with
  `dangerouslySetInnerHTML` + `DOMPurify` (already a dep from 008
  for chat content rendering).

### C. FTS frontend

- Trigger:

  - New keyboard shortcut `Ctrl+/` (008 keyboard registry; the
    existing `Ctrl+K` stays the navigation palette and is
    unchanged).
  - Sidebar top: a search input with magnifier icon. Click or
    `Ctrl+/` focuses it.

- New page `features/search/SearchPage.tsx`:

  - Input (300 ms debounce; below that the user is mid-typing).
  - Result list: snippet (rendered safely, `<mark>` highlighted),
    channel name + sender + relative time. Click → navigate to
    `/w/:wsSlug/c/:channelSlug?msg=<messageId>` (reuses the 011
    mention-jump pattern).
  - Empty input shows recent searches (localStorage, max 5,
    `qufox.search.recents` key).
  - Cursor pagination: "Load more" button at the bottom or
    auto-load on intersection (whichever the existing
    MessageList pattern uses).

- `useSearch(q, opts)` query hook (TanStack Query, debounced
  via the input not the hook so cache keys stay stable).

- E2E `apps/web/e2e/search.e2e.ts`:

  - Author posts message "hello world" in channel C.
  - Other user opens search via `Ctrl+/`, types "hello".
  - Result list shows one row, snippet contains `<mark>hello</mark>`.
  - Click result → URL contains `?msg=<id>`, channel scrolls to it.
  - Private-channel non-member: posts in private channel are
    NOT in the result list (ACL filter assertion).

## Scope (OUT) — future tasks

- Korean morphological analyzer (mecab-ko, jieba) — beta uses
  trigram, real analyzer is a follow-up once traffic justifies.
- Cross-workspace search.
- Sort options (newest / relevance) — relevance only for now.
- Attachment file content indexing (PDF / docx OCR).
- Server-stored search history (privacy: localStorage only).
- Saved searches / search alerts.
- Loki self-hosted logs — TODO(task-019).
- Beta operations (admin onboarding, whitelist, feedback widget).
- PITR / WAL archiving — separate ops task.
- sops / age secret encryption — separate ops task.
- Custom emoji upload — separate task.
- Residual LOW/NIT follow-ups (010 follow-1/2, 011 follow-9,
  012 follow-2/6/7/8/11, 009 LOW/NIT residue) — defer to a
  later sweep.

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to `docs/tasks/015-*.PR.md`.
- `pnpm --filter @qufox/api test:int` green on GitHub Actions.
  New specs:
  - `search.int.spec.ts` (Korean substring via trgm, English exact
    via tsvector, ACL filter, ts_rank ordering, ts_headline snippet
    contains `<mark>`)
  - `error-code-schema.unit.spec.ts` — every backend enum value
    is in `shared-types::ErrorCodeSchema` (regression guard for
    014-follow-3).
- `pnpm --filter @qufox/web test:e2e` green on GHA:
  - `search.e2e.ts` newly added (`Ctrl+/` trigger + result click
    - ACL).
- One Prisma migration, **reversible-first**:
  - `add_message_search.sql` — extension + ALTER + raw SQL
    appendix for the two `CONCURRENTLY` indexes.
  - down: drops indexes + column; leaves `pg_trgm` extension in
    place (other features may rely on it later).
- TODO regression guard:
  - `grep -rn 'TODO(task-014-follow-2\|TODO(task-014-follow-3\|TODO(task-012-follow-4\|TODO(task-012-follow-5\|TODO(task-012-follow-10\|TODO(task-011-follow-8\|TODO(task-010-follow-5\|TODO(task-009-nit-3' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**.
- EXPLAIN evidence in `015-*.PR.md` — `GET /search` query plan
  uses GIN index scan (`messages_search_tsv_idx` or
  `messages_content_trgm_idx`), single round trip, no seq scan.
- Three artefacts: `015-*.md`, `015-*.PR.md`, `015-*.review.md`.
- One eval added: `evals/tasks/030-message-search.yaml`.
- Reviewer subagent **actually spawned**; transcript token count
  recorded in `015-*.review.md` header.
- **Direct merge to develop** (PR creation skipped). Commit
  message: `Merge task-015: full-text search + priority hygiene`.
- **REPORT printed to chat automatically** after merge — without
  the user asking. Per `feedback_handoff_must_include_report.md`.
- Feature branch retained (no deletion prompt). Per
  `feedback_retain_feature_branches.md`.

## Prerequisite outcomes

- 014 merged to develop (`9d1cc10`).
- `ChannelAccessService` (014-A single entry point) is the ACL
  source for the FTS query's `visibleChannelIds` and the
  per-result re-check.
- `ErrorCodeSchema` drift gets resolved in 015-A first so the
  baseline for B/C is clean (B introduces no new error codes,
  but a clean baseline avoids confusion).

## Design Decisions

### `pg_trgm` + `simple` config, no external analyzer

Adding mecab-ko or jieba means a custom Postgres image, NAS
docker recompile, and new operational surface (analyzer
dictionaries, version bumps). For beta-volume Korean search,
trigram covers substring matching (the user's "어디 있더라"
intuition) with zero install. English uses the `simple`
tsvector path. The OR query lets the planner pick whichever
index is cheaper.

The path to a real analyzer is open: change the generated
column expression to `to_tsvector('korean_mecab', content)`,
rebuild the GIN index, leave the API surface identical.

### Two-pass ACL

Filtering by `channel_id IN (visibleChannelIds)` at query time
is the primary control. Re-checking with `ChannelAccessService`
on each response row covers the edge case where ACL flips
between query plan and result rendering — a kicked member
shouldn't see a result fly in just because their permission
mask was stale at SELECT time. The re-check is in-memory
(no extra DB query) so cost is negligible.

### Snippet contains HTML; frontend sanitizes

`ts_headline` returns the snippet with `<mark>` wrapping the
match. Sending pre-rendered HTML is simpler than computing match
positions and re-rendering client-side. `DOMPurify` (already a
dep from 008) sanitizes against XSS — the `simple` tokenizer
isn't injecting HTML, but defense-in-depth.

### Search history is local

Server-stored search history is PII. localStorage is
device-bound and the user can clear it. Beta-grade is enough.

### `Ctrl+/` not `Ctrl+K`

`Ctrl+K` is the navigation palette from 008 — opening different
UI on the same shortcut depending on context is anti-pattern.
`Ctrl+/` is unused, common in Slack/GitHub for search, and the
help shortcut from 008 is `?` (no Ctrl) so no collision.

## Non-goals

- Morphological analysis.
- Search-result reactions/mention/reply badges.
- Attachment text indexing.
- Server-side search history.

## Risks

- **GIN index size growth** — 1M messages × 100 chars avg → trgm
  index in the GB range. Mitigation: partial index
  `WHERE deleted_at IS NULL` excludes soft-deleted; beta
  expected under 100k messages, well within budget. Monitor
  via `pg_relation_size('messages_content_trgm_idx')` in
  observability later.
- **`CREATE INDEX CONCURRENTLY` outside transaction** — Prisma
  migrations run in a transaction by default; raw-SQL appendix
  is needed (014 set the pattern). PR.md must mention this so
  reviewers know it's intentional, not an oversight.
- **Korean trigram precision** — "안녕하세요" search matches
  "녕하세" too. User may flag low precision. Mitigation:
  `ts_rank` orders strict matches first; `ts_headline`
  highlights the actual matched substring so users see what
  matched. Real analyzer is a deliberate future task.
- **`ErrorCodeSchema` fix lights up unknown enum values** — once
  shared-types accepts the new codes, frontends that switch on
  errorCode see new branches. Audit web's error-handling
  switch statements, add fallback to "unknown error" toast.
- **Search rate limit annoys keyboard-fast users** — 30 req/min
  is below 1 req/2s. With the 300ms debounce, a user typing
  fast issues at most 1 req/300ms → still within limit only
  if they pause. Bump to 60/min if reviewer pushes back; the
  cap is to prevent scripted abuse, not real usage.
- **`apply-nginx-diff.sh` include rewrite (012-follow-4)** —
  may reveal that the EOF-append from 011-A was wrong for
  include-style configs. If so, rewrite as "find the
  `include conf.d/*.conf;` directive, drop a new file in
  conf.d/ instead of appending." Implementer chooses based on
  what the actual NAS nginx.conf looks like.
- **Reviewer asks why no Loki here** — Loki is a separate task.
  FTS is search-over-messages; Loki is log aggregation. Two
  different problems. The doc says so explicitly.
- **15-A may be a no-op** — UNDERSTAND grep might find that all
  8 hygiene items were already fix-forward'd in 014 cleanup.
  Acceptable; the REPORT will say "0 of 8 still live, all
  cleaned in 014" and the chunk closes early.

## Progress Log

_Implementer fills this section. Three commit groups: A
(hygiene), B (FTS backend), C (FTS frontend). A → B → C
recommended so the ErrorCodeSchema baseline is clean before
B touches API surface that may use new error codes._

- [ ] UNDERSTAND (hygiene grep, ChannelAccessService API
      verification, NAS nginx.conf structure check)
- [ ] PLAN approved
- [ ] SCAFFOLD (search migration red, SearchService stub,
      ErrorCodeSchema drift unit test red)
- [ ] IMPLEMENT (A → B → C)
- [ ] VERIFY (`pnpm verify` after each + GHA green)
- [ ] OBSERVE (EXPLAIN captured for /search; Korean and English
      sample queries shown; ACL exclusion verified)
- [ ] REFACTOR
- [ ] REPORT (PR.md, reviewer spawned, eval added, direct merge,
      **REPORT printed automatically**)
