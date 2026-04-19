# Task 000 — Bootstrap: Agentic Harness Scaffolding

## Context

First commit. Stands up monorepo + NestJS/Vite/Postgres/Redis scaffold and the
full AI agent harness (settings, subagents, hooks, eval, CI/CD, IaC skeleton).
Feature code is deliberately minimal; the point is that subsequent tasks
execute on top of a working harness.

## Scope (IN)

- pnpm + Turborepo monorepo layout
- apps/api (NestJS 10) + apps/web (React 18 + Vite + Tailwind)
- Prisma schema + deterministic seed
- docker-compose (profiles: dev/test/e2e)
- Observability primitives: Pino logger, requestId middleware, errorCode enum,
  domain exception filter, /healthz, /readyz
- Realtime gateway — ping/pong only
- Shared Zod contracts in packages/shared-types
- .claude/ (settings + 3 commands + 7 subagents + guard hook w/ self-test)
- GitHub Actions: ci / integration / e2e / eval / deploy-staging / deploy-prod
  / db-migrate / codeql
- Dependabot + CODEOWNERS
- Eval harness skeleton (dry-run parses 3 yaml tasks, writes report)
- Infra skeleton: Terraform, K8s, Helm (no apply backends wired)
- Devcontainer, .nvmrc, pinned versions, lockfile

## Scope (OUT) — pushed to later tasks

- Auth module (JWT + refresh rotation) → task-001
- Workspace REST → task-002
- Channel REST → task-003
- Message REST + cursor pagination → task-004
- Realtime broadcast + Redis adapter → task-005
- Web shell (sidebar + message pane) → task-006
- Realtime UI wiring → task-007
- Deploy pipelines wired to real AWS OIDC / ECR / helm creds → task-010

## Acceptance Criteria (mechanical)

1. `pnpm bootstrap` completes from clean checkout.
2. `pnpm verify` → exit 0 (lint + typecheck + unit + contract).
3. `pnpm test:int` → exit 0 (Testcontainers ping/pong round-trip).
4. `pnpm test:e2e` → exit 0 (Playwright via dockerized image).
5. `pnpm smoke` → exit 0 once `pnpm dev` is up.
6. `pnpm debug:dump` → `./.debug/latest.json` exists.
7. `pnpm eval -- --dry-run` → exit 0, `evals/report.md` + `report.json` updated.
8. `.claude/hooks/guard.sh --self-test` → exit 0.
9. CLAUDE.md present and contains full harness spec.
10. First commit uses Conventional Commits (`chore: bootstrap agentic harness`).

## Non-goals

- Any real prod deployment.
- Real JWT logic.
- Real WS fanout across nodes.
- Real eval headless harness execution.

## Risks

- **Synology kernel 4.4** may not support newer Testcontainers/ryuk.
  Mitigation: tests also gate on CI (Ubuntu); local `test:int` falls back
  to docker-compose services.
- **Playwright browsers** require Ubuntu-class glibc.
  Mitigation: `pnpm test:e2e` runs inside `mcr.microsoft.com/playwright` image.
- **Prod-mode prevention drift** — if CI labels change, guard patterns in
  `.claude/hooks/guard.sh` may diverge. Mitigation: self-test in Phase 6.
