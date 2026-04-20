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
RUN pnpm --filter @qufox/webhook build

FROM node:20.9.0-alpine AS runtime
RUN apk add --no-cache docker-cli bash git curl tini
WORKDIR /app
COPY --from=build /app/services/webhook/dist ./dist
COPY --from=build /app/services/webhook/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
ENV NODE_ENV=production
EXPOSE 9000
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]
