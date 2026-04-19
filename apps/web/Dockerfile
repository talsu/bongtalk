# syntax=docker/dockerfile:1.7
# Multi-stage build for @qufox/web: vite build → nginx:alpine serves static assets.
FROM node:20.9.0-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
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
COPY apps/web ./apps/web
RUN pnpm --filter @qufox/shared-types build \
 && pnpm --filter @qufox/web build

FROM nginx:1.25-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
