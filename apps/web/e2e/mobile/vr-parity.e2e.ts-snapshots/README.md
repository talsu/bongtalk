# VR snapshot baselines — reseed pending (task-029)

Baselines are **not yet committed**. They must seed on the first
CI run after the task-029 mobile CSS wiring fix (`--update-snapshots`).

## Why they were missing before 029

task-024-I seeded the VR spec but the baselines were never committed
(documented as `TODO(task-024-follow-3)`). The VR test was then
silently passing against "no baseline" because `toHaveScreenshot`
treats a missing baseline as "generate on this run". That masked the
root cause the whole way: `index.html` didn't link
`/design-system/mobile.css`, so every qf-m-\* class rendered with zero
styling — and the VR baseline, had it been committed earlier, would
have captured the unstyled tree and green-lit it forever.

## Reseeding

One-shot after task-029 ships:

```sh
pnpm --filter @qufox/web test:e2e \
  --grep "mobile shell renders stably" \
  --update-snapshots
```

The command produces
`mobile-shell-iphone-se-chromium-linux.png` and
`mobile-shell-iphone-14-chromium-linux.png`. Commit them; subsequent
CI runs diff against them with `DS_PARITY_THRESHOLD` (default 2 %,
raise to 3–5 % if font antialiasing drifts).

## Regression guard (029-D)

`scripts/deploy/tests/dist-css-link-smoke.sh` (pnpm `ds:smoke`) now
runs in CI and fails the build if `dist/index.html` is ever missing
any of tokens / components / mobile / icons. That's the stronger,
faster guard — VR baselines are a cosmetic safety net on top.
