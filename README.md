# qufox

Discord-like real-time communication platform — monorepo harness.

See `CLAUDE.md` for architecture, principles, agent protocol, and full harness spec.

## Quick Start

```bash
pnpm bootstrap      # install + db up + migrate + seed
pnpm dev            # full-stack hot reload
pnpm verify         # lint + typecheck + unit + contract
pnpm test:int       # Testcontainers integration
pnpm test:e2e       # Playwright e2e (dockerized)
pnpm smoke          # cURL smoke
```

## Layout

- `apps/api` — NestJS + Prisma (Node 20)
- `apps/web` — React + Vite + Tailwind
- `packages/shared-types` — Zod contracts
- `packages/config` — shared eslint/tsconfig
- `evals/` — agent eval harness
- `infra/` — Terraform, K8s, Helm skeletons
- `.claude/` — agent settings, commands, subagents, hooks

## Harness Commands

See table in `CLAUDE.md §🧰 Single-Command Harness`.

## Status

Phase 0 — Bootstrap harness. See `docs/tasks/000-bootstrap.md`.
