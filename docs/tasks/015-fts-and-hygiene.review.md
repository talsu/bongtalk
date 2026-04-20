# Task 015 Review — FTS + priority hygiene

**Reviewer**: reviewer subagent (general-purpose)
**Branch**: feat/task-015-fts-and-hygiene @ 73cf051
**Base**: develop @ 9d1cc10
**Transcript**: ~42k
**Verdict**: approve-with-followups

---

## A (hygiene) findings

1. **ErrorCodeSchema parity** — `packages/shared-types/src/index.ts:43-100` now includes all 8 previously-missing codes: `INVITE_REVOKED` (L69), `ATTACHMENT_NOT_FOUND/TOO_LARGE/MIME_REJECTED/NOT_UPLOADED/SIZE_MISMATCH` (L89-93), `CHANNEL_NOT_VISIBLE` (L94), `FORBIDDEN` (L95). `apps/api/test/error-code-schema.unit.spec.ts` asserts (a) every `Object.values(ErrorCode)` is in `ErrorCodeSchema.options` (L13-22) and (b) every enum value has an `ERROR_CODE_HTTP_STATUS` mapping (L24-28). Both assertions present and correct. **OK.**

2. **Reply-throttle comment** — `apps/web/src/features/realtime/dispatcher.ts:137-146` now explicitly documents that `replyThrottle = new MentionThrottle()` reuses the 5-capacity / 5-tokens-per-sec config (not the previously-written "5/min"). Fix-forward tone is accurate. **OK.**

3. **`apply-nginx-diff.sh` http wrapper pre-check** — `scripts/setup/apply-nginx-diff.sh:59-69` detects outer `http {` wrapper via grep heuristic (opens `http {` + no `# end http` sentinel), bails with a remediation message, and honors `ALLOW_HTTP_WRAPPER=1` to force-append and fall back on `nginx -t` rollback at L174. Shape matches the contract. **OK.**

4. **orphan-gc preamble** — `scripts/backup/attachment-orphan-gc.sh:18-28` adds the "two-step ordering is intentional and convergent — not atomic" block and walks through the crash-between-S3-and-DB case (next run's S3 delete = 204 no-op → DB delete completes). Matches 012-follow-5 intent. **OK.**

5. **runbook `/volume1 → /volume3` migration rsync** — `docs/ops/runbook-backup-restore.md:15-34` adds a "Migrating pre-task-012 backups from /volume1" section with a `rsync -aHAX --remove-source-files` + `find ... -type d -empty -delete` recipe marked idempotent. **OK.**

6. **unread-propagation E2E** — `apps/web/e2e/realtime/unread-propagation.e2e.ts:118-127` replaces the prior `mentions: { everyone: true }` client payload with `content: \`@${memberUsername} ping\``(server extracts mentions from text; the client-sent`mentions` payload is ignored). Inline comment at L118-125 explains the switch. Test name still asserts mention-dot visibility. **OK.**

7. **ESLint palette pattern** — `eslint.config.mjs:17-18` defines both `PALETTE_PATTERN_LITERAL` (Literal node match) and `PALETTE_PATTERN_TEMPLATE` (`TemplateElement[value.raw=/.../]`). Both selectors are registered in the warn block (L87-90) AND the error block (L103-106). Comment at L11-15 documents why the template selector is needed. **OK.**

8. **Webhook redelivery dedupe** — `services/webhook/src/server.ts:27-43` implements a 64-entry insertion-order `Set` with `rememberDelivery()` + test-only `resetDeliveryDedupe()`. Hook placed after allowlist check at L269-278 so ignored branches don't burn a slot — good placement. The spec at `services/webhook/test/server.spec.ts:222-245` sends two identical deliveries with the same `x-github-delivery` header, asserts second → 200 + `ignored: true`, and asserts `submitted.length === 1`. `beforeEach` at L72-78 calls `resetDeliveryDedupe()`. **OK.**

---

## B (FTS backend) findings

**No BLOCKER / HIGH items.**

### MED — migration uses plain `CREATE INDEX`, not `CONCURRENTLY`

`apps/api/prisma/migrations/20260424000000_add_message_search/migration.sql:33-39` runs `CREATE INDEX "Message_search_tsv_idx" ...` (non-concurrent). The preamble comment at L17-25 acknowledges this and points at a yet-to-be-written `scripts/deploy/sql/task-015-message-search-concurrent.sql` for prod. The contract explicitly said "CONCURRENTLY appendix"; the PR.md calls it deferred to a "follow-up (015-follow-N)". Acceptable as a deferred follow-up for empty dev/test DBs, but the follow-up script must land before any populated prod deploy or the rollout will take an AccessExclusive lock on `Message`. **Defer to task-015-follow-1.**

### LOW — `SearchService.search()` uses OR not LATERAL

The contract's "SearchService.search() is a single $queryRaw with LATERAL OR" description mentions LATERAL; the actual query at `apps/api/src/search/search.service.ts:151-164` is a single SELECT with an OR predicate (`search_tsv @@ plainto_tsquery` OR `content ILIKE '%q%'`). The OR form is correct and simpler than a LATERAL join here — the reviewer instructions likely conflated "OR of two paths" with "LATERAL". No semantic issue; both indexes can still be picked by the planner. **OK as shipped; language drift in the contract.**

### LOW — ampersand double-escape visible to user

`search.service.ts:143-147` runs `replace('&','&amp;')` then `replace('<','&lt;')` then `replace('>','&gt;')` on content before `ts_headline`. A message containing a literal `&` (e.g., "Tom & Jerry") produces `Tom &amp; Jerry` in the snippet. The frontend `markOnlyHtml` at `apps/web/src/features/search/sanitize.ts:14-23` then re-escapes `&` to `&amp;`, yielding `Tom &amp;amp; Jerry` rendered as innerHTML → displays `Tom &amp; Jerry` instead of `Tom & Jerry`. Defense-in-depth is intentional, but the user sees a cosmetic double-escape. **Defer to task-015-follow-2 — small display-only issue.**

### LOW — `visibleChannelIds` loops N times catching thrown errors

`search.service.ts:62-82` fetches every channel in the workspace then calls `resolveEffective()` in a loop, catching `WORKSPACE_NOT_MEMBER` silently. For a true outsider (not a member at all), every iteration throws (one membership check per channel = N DB round trips) before the function returns `[]`. Since `resolveEffective` queries `workspaceMember` on every call, the membership lookup runs N times. Comment at L67 acknowledges "fold the loop into a single SQL aggregate" when scale demands. Acceptable beta-grade; flag as "monitor as channel counts grow past ~50" — same note the PR.md already carries. **Defer to task-015-follow-3.**

### NIT — cursor tuple comparison

`search.service.ts:111-116` builds the keyset predicate with the row-tuple `(ts_rank(m."search_tsv", plainto_tsquery...), m."createdAt", m.id) < (${cursor.rank}, ...)`. This re-evaluates `ts_rank` per row for the WHERE; the planner may not push the tuple comparison below the Sort. Functional correctness fine; performance on deep pagination is untested. The int spec exercises limit=20 and < 30 rows so this path isn't stressed. **Defer to task-015-follow-3.**

### Verified ACL surface

- `visibleChannelIds` goes through `ChannelAccessService.resolveEffective` (`search.service.ts:75`), masks with `& Permission.READ` (L76). Confirmed `Permission.READ = 0x0001` at `apps/api/src/auth/permissions.ts:17`.
- Query filters by `m."channelId" = ANY(ARRAY[...]::uuid[])` at `search.service.ts:155-157`.
- SearchController at `/search` uses `JwtAuthGuard` (`search.controller.ts:20`), enforces 30/60s rate limit at L37 (key `search:u:<userId>`; prefix lookup confirmed in the int spec flush `rl:search:*`).
- Missing-q → 400 VALIDATION_FAILED (L38-40); missing workspaceId → 400 VALIDATION_FAILED (L41-43).
- `SearchModule` in `AppModule.imports` at `app.module.ts:20,43`.
- `SearchResultSchema` + `SearchResponseSchema` at `packages/shared-types/src/message.ts:132-148`.
- `Message.search_tsv` at `apps/api/prisma/schema.prisma:201`: `Unsupported("tsvector")?`.

### Int spec coverage

`apps/api/test/int/search/search.int.spec.ts` covers:

- missing-q 400 (L97-103)
- English tsvector hit w/ `<mark>hello</mark>` (L105-117)
- XSS-safety `<script>` → `&lt;script&gt;` (L119-139)
- Korean `녕하세` substring (L141-153)
- ACL outsider 0 + private excluded for workspace member (L155-176)
- Soft-delete excluded (L178-195)
- EXPLAIN asserting `not /Seq Scan on "Message"/` (L197-222)

All 7 declared cases present and asserting the claimed shape.

---

## C (FTS frontend) findings

**No BLOCKER / HIGH items.**

### Verified shortcut rewiring

- `useShortcut.ts:68-72` binds Ctrl/Cmd+/ → `setOpenModal('search')`. `matches({key:'/',ctrlOrMeta:true})` requires both Ctrl pressed AND `e.key === '/'` — won't collide with the `?` branch (L76-80) which has no Ctrl requirement.
- `ui-store.ts:10` — `openModal` enum literal set: `'command-palette' | 'shortcut-help' | 'settings' | 'search' | null`. `'search'` present.
- `ShortcutHelp.tsx:4-14` combo list has both `Ctrl/Cmd + /` → '메시지 검색' and `?` → '이 도움말 열기'.
- `BottomBar.tsx:46` tooltip reads `단축키 (?)`.

### Verified SearchOverlay

- `SearchOverlay.tsx:20-22` — Dialog keyed on `openModal === 'search'`; early `return null` at L81.
- 300ms debounce at L55-58.
- Empty state renders `<RecentList>` (L99-107) when `debounced.length === 0`.
- Result click at L71-79 sets openModal=null and navigates to `/w/${slug}/${chName}?msg=${r.messageId}` (reuses 011 mention-jump).
- Snippet rendered via `dangerouslySetInnerHTML={{ __html: markOnlyHtml(r.snippet) }}` at L137.

### Verified sanitize.ts + sanitize.spec.ts

- `sanitize.ts:14-23` — escapes all angle brackets first, then selectively restores `<mark>` / `</mark>`, including the double-escaped `&amp;lt;mark&amp;gt;` shape.
- `sanitize.spec.ts` has 4 tests: mark intact (L5-7), script injection escaped (L9-14), server-double-escape (L16-21), standalone angle brackets (L23-25). All assertions on output strings.

### Verified useSearch + api

- `useSearch.ts:12-27` — `useInfiniteQuery` keyed by `['search', workspaceId, q, channelId ?? null]`; `enabled: q.trim().length > 0 && !!workspaceId` (L25); `getNextPageParam` reads `last.nextCursor ?? undefined`.
- Recent searches API: `loadRecentSearches()` (L36-46), `pushRecentSearch()` (L48-59), de-duped + max 5 + localStorage backing.
- `api.ts:12-26` — thin `apiRequest` wrapper around `GET /search?<qs>`.

### Shell mount

`Shell.tsx:14,99` imports and mounts `<SearchOverlay />` next to `<CommandPalette />` and `<ShortcutHelp />`. **OK.**

### E2E `search.e2e.ts`

- Two contexts (aCtx / bCtx) at L30-31.
- A posts in #general (L63-70) + in private #leadership (L71-78).
- B logs in via `/login` (L81-85), opens Ctrl+/ via `bPage.keyboard.press('Control+/')` (L89).
- Asserts snippet contains `<mark>hello</mark>` via `innerHTML()` (L99-100).
- Asserts no private-channel results: loops rows and asserts each `toContainText('# general')` (L103-109).
- Click → URL contains `?msg=` (L112-115). Overlay closes (L116).

**All C claims confirmed.**

---

## Cross-cutting

- **No `any` leaks** — grep for `: any\b` in `apps/api/src/search` and `apps/web/src/features/search` = 0 hits.
- **Migration shape** — extension IF NOT EXISTS → ALTER TABLE ADD COLUMN GENERATED ALWAYS AS STORED → two partial GIN indexes WHERE `deletedAt IS NULL`. Correct order. Plain CREATE INDEX (not CONCURRENTLY) — see B-MED above.
- **Rate limits** — 30/min/user on `/search` with a 300ms client debounce means a fast typist stays under. 64-entry LRU for webhook redelivery dedupe — reasonable; GitHub redelivery is near-term so older entries aging out is fine.
- **No destructive migration** — the migration is pure additive (CREATE EXTENSION, ADD COLUMN, CREATE INDEX).
- **Conventional commits** — 4 commits: `docs(task-015)`, `refactor(hygiene)`, `feat(search)` ×2. All well-formed with scope + colon.
- **No secrets** — grep of the diff shows nothing that looks like a token/password/URL with embedded creds.
- **TODO regression guard** — `grep -rn 'TODO(task-014-follow-2\|-follow-3\|-012-follow-4\|-follow-5\|-follow-10\|-011-follow-8\|-010-follow-5\|-009-nit-3' --include='*.ts' --include='*.tsx' --include='*.sh' .` → **0 lines**. Contract AC met.
- **Eval** — `evals/tasks/030-message-search.yaml` present.

---

## Deferred to task-015-follow-\*

1. **task-015-follow-1 (MED, prod-blocker-before-next-deploy)** — write `scripts/deploy/sql/task-015-message-search-concurrent.sql` that runs `CREATE INDEX CONCURRENTLY` for `Message_search_tsv_idx` and `Message_content_trgm_idx`, and wire it into the deploy hook to run BEFORE `prisma migrate deploy` on prod. Without this, the next prod deploy against a populated `Message` table will hold an AccessExclusive lock through the index build.

2. **task-015-follow-2 (LOW, display)** — cosmetic double-escape of literal `&` characters in snippets. Either drop the client-side `replace(/&/g, '&amp;')` pass (server already escapes) and trust the server escape, or move to a different defense-in-depth shape that doesn't re-escape already-escaped chars.

3. **task-015-follow-3 (LOW, perf)** — `SearchService.visibleChannelIds` N×1 membership checks + re-evaluated `ts_rank` in cursor predicate. Fold channel-visibility loop into one SQL aggregate; consider caching `ts_rank` in a subquery / CTE for the cursor comparison so the planner can push the keyset below the Sort.

---

**Merge recommendation:** approve-with-followups. The three items above are all deferrable — none block feature-level correctness on dev/test or the initial rollout on an empty-Message table. Land to develop; file the three follow-ups immediately.
