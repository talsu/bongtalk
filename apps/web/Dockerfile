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
# task-011 reviewer MED-5: make VITE_API_URL a build arg so the e2e
# compose stack can point the baked bundle at the test-api container's
# host-exposed port (http://localhost:43001) instead of the prod
# default. ARG is passed via `docker compose build` args.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @qufox/shared-types build \
 && pnpm --filter @qufox/web build

FROM nginx:1.25-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# task-019 hotfix: normalise file permissions so nginx worker (runs as
# the `nginx` user) can read everything. NAS host umask is 0077, which
# meant files under apps/web/public/ (copied verbatim by Vite into
# dist/) carried mode 0600 into the image → 403 on /design-system/* +
# /brand-assets/*. `a+rX` grants read everywhere + execute only on
# directories so traversal still works; owner-write stays untouched.
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
