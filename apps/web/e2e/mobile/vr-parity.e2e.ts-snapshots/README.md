# VR snapshot baselines (task-025 follow-3)

This directory holds the pixel-diff baselines for
`apps/web/e2e/mobile/vr-parity.e2e.ts`. Each commit in this folder
corresponds to a `toHaveScreenshot` call — iPhone SE (375×667) and
iPhone 14 (390×844).

## Seeding the baselines

On first CI run or after a deliberate visual change, run Playwright
with `--update-snapshots` so the expected PNGs are generated and
committed:

```sh
pnpm --filter @qufox/web test:e2e \
  --grep "mobile shell renders stably" \
  --update-snapshots
```

This produces `mobile-shell-iphone-se-chromium-linux.png` and
`mobile-shell-iphone-14-chromium-linux.png` (exact names platform
dependent). Commit the PNGs — `toHaveScreenshot` will compare against
them on every future run, failing if the pixel diff exceeds
`DS_PARITY_THRESHOLD` (default 2 %, raise to 3–5 % if rendering
drift is acceptable).

## Why the baselines aren't pre-committed here

Baselines must be generated against the same Playwright Chromium
build CI uses. Seeding them from a developer machine (NAS / laptop)
would embed font-antialiasing diffs that CI can't match, flipping
every CI run to red on the first compare. The canonical seed happens
on the GHA runner.

task-025-follow-3 (LOW) — see `docs/tasks/025-mobile-polish-loop.md`
§ A-3 for the full rationale.
