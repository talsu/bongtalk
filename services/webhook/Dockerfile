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
RUN apk add --no-cache docker-cli bash git curl tini openssh-client
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
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]
