# syntax=docker/dockerfile:1.7
# Small webhook receiver. Runs inside the `internal` network so nginx can
# reach it by name (`qufox-webhook`). Needs docker socket access to spawn
# deploys — see compose.deploy.yml for the bind mount.
FROM node:20.9.0-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY services/webhook/package.json services/webhook/package.json
RUN pnpm install --filter @qufox/webhook... --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY services/webhook services/webhook
COPY tsconfig.base.json ./
RUN pnpm --filter @qufox/webhook build \
 && pnpm --filter @qufox/webhook --prod --legacy deploy /out

FROM node:20.9.0-alpine AS runtime
# docker-cli-compose carries the `docker compose` subcommand (plugin
# form). Without it `docker compose --env-file …` fails with
# "unknown flag: --env-file" on the first migrate-deploy run, which
# is exactly what auto-deploy.sh shells out every webhook call.
RUN apk add --no-cache docker-cli docker-cli-compose bash git curl tini openssh-client
# Task-017-D: seed /tmp/known_hosts with GitHub's SSH host key at
# build time. OpenSSH's `git fetch origin main` path tries to update
# its known_hosts after each successful connection; the operator's
# deploy-key directory is bind-mounted read-only, so the update
# write failed and every deploy log carried
#   "hostfile_replace_entries: mkstemp: Read-only file system"
# as a pair of warning lines. The ssh invocations in auto-deploy.sh
# now use `-o UserKnownHostsFile=/tmp/known_hosts` to write to
# tmpfs, and we pre-seed the file at build time so the first
# `git fetch` doesn't have to prompt/accept.
RUN ssh-keyscan -t ed25519,rsa github.com > /tmp/known_hosts-seed 2>/dev/null \
  && chmod 0644 /tmp/known_hosts-seed
WORKDIR /app
# `pnpm deploy --legacy` emits a flat project with a real node_modules
# tree (no pnpm symlink farm), so prom-client + any other dep resolves
# at runtime. The earlier `COPY --from=deps /app/node_modules` brought
# only the hoisted root modules and missed services/webhook-scoped
# ones — boot crashed with `Cannot find module 'prom-client'`.
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
ENV NODE_ENV=production
EXPOSE 9000
# Copy the seeded hosts file into tmpfs (/tmp) on every container
# start, then exec the node app. tmpfs is writable so OpenSSH's
# post-connect update lands somewhere; each restart reseeds.
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "cp /tmp/known_hosts-seed /tmp/known_hosts 2>/dev/null || true; exec node dist/main.js"]
