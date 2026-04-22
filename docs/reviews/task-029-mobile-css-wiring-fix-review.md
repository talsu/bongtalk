# task-029 Mobile CSS Wiring Fix Review — emergency hotfix

Adversarial re-read of `feat/task-029-mobile-css-wiring-fix` at tip
`0524ab3` (docs 029-B+E), built on `f79d938` (fix A+D) and `def54ae`
(task contract).

Root cause: `apps/web/index.html` never linked
`/design-system/mobile.css`, so every `.qf-m-*` class in prod rendered
unstyled. Committed VR baselines would have frozen that state, but
task-024-I never actually committed baselines — `toHaveScreenshot`
silently "generated on first run" and always passed. Two masks, one
symptom.

## BLOCKER

None.

## HIGH

None. Each of the five checks resolves cleanly:

1. **`<link>` order.** `tokens → components → mobile → icons`.
   `mobile.css` header comment (L2) declares
   `Requires tokens.css + components.css`. The only variables
   `mobile.css` consumes (`--bg-chat`, `--text-strong`, `--accent`,
   `--fs-15`, `--s-2`, `--r-md`, `--divider`, `--danger-400`,
   `--ok-400`, …) all originate in `tokens.css`, and the single
   cross-ruleset reference (`.qf-memberlist` at L360) lives inside
   `@media (max-width: 768px)` and is an **override** of a
   `components.css:553` rule — ordering is therefore required to be
   **after** `components.css`, which matches the placement. Icons
   load after mobile; no dependency between them.

2. **Desktop bleed.** `grep '^[^.\s#/@:*}]' mobile.css` returns zero —
   no bare element/`:root` rules. Every selector is `.qf-m-*` except
   the single `@media (max-width: 768px) { .qf-memberlist { display:
none } }` at L359-361. Desktop JSX renders no `qf-m-*` classes and
   a desktop viewport (>768px) never enters the media block, so
   desktop layout is provably untouched. `.qf-m-row` vs `.qf-row`,
   `.qf-m-channel` vs `.qf-channel` share no selector — no cascade
   collision.

3. **`ds:smoke` actually builds.** `scripts/deploy/tests/dist-css-link-smoke.sh:13`
   runs `pnpm --filter @qufox/web build` (silenced stdout only), then
   greps `apps/web/dist/index.html` for all four `/design-system/${css}`
   links. Vite copies `public/` verbatim to `dist/` and preserves
   `<link>` tags; the grep is on the emitted artefact, not the source.
   Correct regression shape.

4. **CI pnpm/node versions.** The new job pins `version: 10` +
   `node-version: 20`, whereas `integration` pins `10.33.0` +
   `20.9.0`. Minor drift — `pnpm/action-setup@v4` resolves `"10"` to
   latest 10.x and `setup-node@v4` resolves `"20"` to latest 20.x.
   `cache: pnpm` works with either and requires only a
   `packageManager` or `pnpm-lock.yaml` at root — both present. This
   won't block, but see MED-1.

5. **CDN cache.** `qufox-web` is an nginx container recreated on
   every `rollout.sh`; nginx serves the freshly-built `dist/` from
   the new image layer. No CDN sits in front (009 stack is direct
   nginx-proxy). Users get fresh `index.html` on first navigation
   after switchover. OK.

## MEDIUM

1. **pnpm/node version drift in the new CI job.** The rest of the
   repo pins exact versions (`10.33.0`, `20.9.0`) to keep the lockfile
   compatible and avoid a silent engine bump. `ds:smoke` using `"10"`

   - `"20"` works today, but a future pnpm 10.x minor change to
     lockfile v7+ could make `--frozen-lockfile` diverge between the
     two jobs. Follow-up: tighten to the same pins.

2. **Contract ↔ reality drift on "VR baseline reseed."** Task
   contract §B says "replace 4 PNGs (375×667/390×844 × light/dark)"
   on `apps/web/e2e/mobile/mobile-vr-parity.mobile.e2e.ts-snapshots/`.
   The actual spec file is `vr-parity.e2e.ts` (no `mobile-` prefix,
   no `.mobile.` infix), the snapshots dir holds zero PNGs (only the
   new README), and the README itself documents that baselines were
   never committed pre-029. The commit `docs(029-B+E)` is therefore
   a doc-only change — no PNGs were reseeded in this branch. This is
   defensible (first-run `--update-snapshots` in CI will seed), but
   DoD item "VR baseline PNG 4개 교체 + git commit" is literally
   unmet. The stronger guard (`ds:smoke`) is in place, so regression
   coverage is not weakened — but the FINAL REPORT must be honest
   about deferring B to a follow-up task.

3. **Contract §F live-prod verification depends on user action.**
   The `curl /api/readyz` probe is automatable, but "load qufox.com
   on real mobile, compare 4 screens to mockup" is user-side. REPORT
   should enumerate exactly which 4 URLs + viewport settings to test
   so the user gets a deterministic checklist, not a vague "open on
   mobile."

## LOW

1. **`ds:smoke` silences build stdout (`>/dev/null`).** When the
   build fails mid-install, operator sees `[ds-smoke] FAIL:
apps/web/dist/index.html not produced` with no Vite error tail.
   Minor DX; swap to `tee` or let stdout flow on failure.

2. **No `mobile-kb-dodge.css` / `mobile-touch-target.css` in the
   smoke list.** Those two are imported through `MobileShell.tsx`
   (Vite bundle), not `<link>`-loaded, so absence from `dist/index.html`
   is expected. The contract §E confirms this is intentional. Worth
   adding a one-line comment in the smoke script so the next reader
   doesn't wonder why only 4 are checked.

3. **`@media (max-width: 768px)` breakpoint hard-coded.** Not this
   task's scope, but the mobile shell uses 768px as its crossover
   while DS tokens define no `--bp-*` variable. Future DS evolution
   may want to hoist the breakpoint. Noted for DS follow-up, not a
   029 gate.

4. **Task contract eval file mention.** Contract lists
   `evals/tasks/040-mobile-css-wiring.yaml` as DoD but the file list
   above does not mention it. If it wasn't added, DoD is partial.
   Ask implementer to confirm.

## Verdict

**PASS** — merge to develop, auto-promote to main.

Core fix (single `<link>` line in correct position) is surgically
right, CI guard (`ds:smoke`) correctly shields against regression at
the dist artefact level (stronger than VR baselines would be), and
DS source-of-truth files are untouched per memory. MED-1 (version
pin drift), MED-2 (VR baseline reseed deferred to first CI run), and
LOW-1..4 are documentation / follow-up items, not gates. The one-line
fix must ship.
