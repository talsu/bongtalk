# syntax=docker/dockerfile:1.7
# Multi-stage build for @qufox/api in a pnpm workspace monorepo.
# Stages: deps (pnpm install) → build (swc compile + prisma generate) → runtime (minimal).
FROM node:20.9.0-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache openssl libc6-compat \
 && corepack enable \
 && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./tsconfig.base.json
COPY turbo.json ./turbo.json
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @qufox/shared-types build \
 && pnpm --filter @qufox/api exec prisma generate \
 && pnpm --filter @qufox/api build
RUN pnpm --filter @qufox/api --prod --legacy deploy /out \
 && cp -r /repo/apps/api/dist /out/dist \
 && cp -r /repo/apps/api/prisma /out/prisma

FROM node:20.9.0-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat tini \
 && npm i -g prisma@5.22.0
ENV NODE_ENV=production
COPY --from=build /out /app
RUN prisma generate --schema=prisma/schema.prisma
# task-020-B: normalise file permissions so a NAS host with umask 0077
# can't ship 0600 files that the runtime user would refuse to read.
# `a+rX` grants read on every file and execute on every directory
# (but NOT on files) — safe mirror of apps/web/Dockerfile's 019 fix.
RUN chmod -R a+rX /app
EXPOSE 3001
ENTRYPOINT ["/sbin/tini","--"]
CMD ["sh","-c","prisma migrate deploy --schema=prisma/schema.prisma && node dist/main.js"]
