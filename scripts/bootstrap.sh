#!/usr/bin/env bash
# qufox bootstrap: install deps -> db up -> migrate -> seed
# exits non-zero on any failure; idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[bootstrap] 1/5 verifying .env.example keys"
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[bootstrap]   created .env from .env.example"
fi
node --experimental-strip-types scripts/verify-env.ts 2>/dev/null \
  || pnpm exec tsx scripts/verify-env.ts

echo "[bootstrap] 2/5 installing dependencies (pnpm)"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "[bootstrap] 3/5 starting postgres + redis (docker compose, profile=dev)"
docker-compose --profile dev up -d postgres redis
# Wait for postgres
for i in $(seq 1 30); do
  if docker-compose exec -T postgres pg_isready -U qufox -d qufox >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[bootstrap] 4/5 prisma generate + migrate"
pnpm --filter @qufox/api exec prisma generate
if [ -z "$(ls -A apps/api/prisma/migrations 2>/dev/null | grep -v '.gitkeep' || true)" ]; then
  echo "[bootstrap]   no migrations yet, creating initial"
  pnpm --filter @qufox/api exec prisma migrate dev --name init --skip-seed
else
  pnpm --filter @qufox/api exec prisma migrate deploy
fi

echo "[bootstrap] 5/5 seeding"
pnpm --filter @qufox/api db:seed

echo "[bootstrap] done."
