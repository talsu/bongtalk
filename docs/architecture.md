# qufox — Architecture

## Runtime topology (MVP)

```
        ┌───────────────┐        ┌──────────────┐
client  │  apps/web     │  HTTP  │  apps/api    │
 (WS)   │  React+Vite   ├───────►│  NestJS      │
 ─────► │               │  WS    │  Socket.IO   │
        └───────────────┘        └──────┬───────┘
                                        │
                            ┌───────────┼───────────┐
                            │           │           │
                        ┌───▼────┐  ┌───▼────┐  ┌───▼────┐
                        │  PG16  │  │ Redis7 │  │  S3    │
                        │ Prisma │  │pub/sub │  │(future)│
                        └────────┘  └────────┘  └────────┘
```

## Layering

- `packages/shared-types` — Zod schemas + `z.infer` types. Single source of
  truth for API ↔ web contracts.
- `apps/api` — NestJS modules (health, realtime; auth/workspaces/channels/
  messages land in task-001..004). Every request gets a `x-request-id` header,
  a structured log line, and a typed error response.
- `apps/web` — Vite + React + Tailwind. `/api` proxied to NestJS in dev.

## Scale strategy

- Stateless API pods → Redis holds sessions / pub-sub.
- Socket.IO + `@socket.io/redis-adapter` for cross-node fan-out (task-005).
- Write-path events go to Redis Streams; read-path uses Postgres + cache.

## Error contract

- Domain error throws `DomainError(code, message)`.
- `DomainExceptionFilter` converts to
  `{ errorCode: ErrorCode, message, requestId }` with status from
  `ERROR_CODE_HTTP_STATUS[code]`.

## Observability

- Pino JSON → stdout (dev: stdout / CI: stdout / prod: Loki or CloudWatch).
- OTEL SDK (stubbed in bootstrap) → exporter=stdout now, Tempo in prod.
- `/healthz` = liveness. `/readyz` = DB + Redis ping.
