# Runbook — DB migration drift

**Alert**: `prisma migrate status` reports schema drift in staging or prod.

## Symptoms

- Staging API pods fail to start with `P3005` or `P3018`.
- `db-migrate` workflow's dry-run step shows unexpected diff.

## First 5 minutes

1. Pull the offending migration file list:
   ```
   kubectl --context=staging exec deploy/qufox-api -- pnpm exec prisma migrate status
   ```
2. Compare with the latest migration in `apps/api/prisma/migrations/`.
3. Decide: is the drift (a) a missing migration, (b) a manual hot-fix, (c) a
   divergent env?

## Resolution

- (a) Missing: run `prisma migrate deploy` manually via the db-migrator subagent.
- (b) Hot-fix: create a new migration that codifies the manual change so CI drift check re-greens.
- (c) Divergent env: restore from most recent logical backup, then replay migrations.

## Escalation

If drift exists in **prod**, stop. Page the on-call DBA. AI is denied
`postgres-prod` MCP by `.claude/settings.json` — do not bypass.
