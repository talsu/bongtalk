# Task 001 — Auth Module: Signup / Login / Refresh / Logout

## Context
Builds the production-grade auth spine that every other domain module
(Workspace / Channel / Message / Realtime) will lean on. Bootstrap (task-000)
provided Prisma, a Redis connection point, `DomainExceptionFilter`, and
`@qufox/shared-types` Zod schemas — this task extends all four.

## Scope (IN)
- Email + password signup/login, argon2id hashing, zxcvbn policy.
- JWT access (15m) + opaque refresh (7d, SHA-256 at rest), refresh rotation,
  re-use detection → family revoke + `auth.session.compromised` event.
- Rate limit (IP 10/min + email 5/15min) + 5-strike 15m account lockout, Redis-backed.
- HttpOnly + Secure + SameSite=Strict refresh cookie on `/auth`.
- Global `JwtAuthGuard` + `@Public()` decorator + `@CurrentUser()`.
- Frontend `/login`, `/signup`, `ProtectedRoute`, AuthProvider with auto-refresh on 401.
- Unit / Integration (Testcontainers) / E2E (dockerized Playwright) — reuse detection
  covered in both integration and e2e.

## Scope (OUT) — pushed to later tasks
- OAuth / social login → task-009
- 2FA / TOTP → task-010
- Password reset via email → task-011
- Password reuse history → task-011
- Email verification → task-012
- Session management UI ("my sessions") → task-013

## Acceptance Criteria (mechanical)
1. `pnpm verify` exit 0
2. `pnpm test:int` exit 0 — includes `refresh.int.spec.ts` reuse detection case
3. `pnpm test:e2e` exit 0 — includes `session-compromise.e2e.ts`
4. Prisma migrate status clean; migration named `add_auth_refresh_tokens`
5. `pnpm smoke` extended (signup → login → /me) still exit 0
6. `pnpm audit --prod --audit-level=high` → 0 high/critical
7. Pino `redact` rules proven by unit test (no password/raw-token/hash in captured logs)
8. All public API bodies Zod-parsed (`@qufox/shared-types/auth`)
9. `.env.example` contains all 9 new keys
10. `bootstrap.sh` → `verify-env.ts` checks new keys
11. `docs/tasks/001-auth.md` (this file) with Progress Log
12. `evals/tasks/004-auth-refresh-rotation.yaml` + `pnpm eval -- --dry-run` green
13. Web app: `/login`, `/signup`, `/` protected, refresh-on-reload, logout clears
14. Reviewer subagent notes captured in Progress Log
15. CI workflows green (run locally; CI will retry on push)

## Non-goals
- Any production-scale concurrency tuning of argon2 parameters.
- Email flows, 2FA, OAuth.

## Risks
- **argon2 native build** on Synology kernel 4.4 — mitigated by using
  `@node-rs/argon2` (Rust prebuilt binaries).
- **Test flakiness around clocks** — every spec calls
  `vi.setSystemTime('2025-01-01T00:00:00Z')`; Redis TTLs in rate-limit tests
  use injected clock helpers rather than real sleep.
- **Rotation race** under concurrent refresh — mitigated by a DB transaction
  that marks the parent token revoked before issuing the child; any second
  request observing the same parent is treated as reuse.

## Progress Log
- `PLAN` — plan emitted, self-confirmed, SCAFFOLD entered.
- `SCAFFOLD` — task doc + shared-types Zod + errorCode + env keys landed first (phase A).
- `db-migrator` — added RefreshToken model, User boost (passwordHash / lockedUntil /
  failedLoginAttempts / lastLoginAt); migration `add_auth_refresh_tokens`; seed updated
  to hash a fixed plaintext (phase B).
- `implementer` — pnpm add @nestjs/jwt / passport-jwt / @node-rs/argon2 / zxcvbn /
  helmet / cookie-parser / @nestjs/event-emitter (phase C); full auth module with
  password/token/rate-limit services, controller, guard (APP_GUARD + @Public), strategy,
  decorators, and session-compromised event (phase D); Prisma/Redis DI modules + main.ts
  helmet/cookieParser/CORS origin wiring + Pino redact rules (phase E).
- `tester` — 4 unit spec files (20 tests), merged integration spec to share one
  Testcontainers stack (signup/login/refresh+reuse/logout/me) — phases F/G.
- `implementer` — frontend AuthProvider + ProtectedRoute + Login/SignupPage +
  api.ts refresh-on-401 + router wiring (phase H).
- `tester` — 3 Playwright e2e files (signup-login-logout / token-refresh /
  session-compromise) — phase I.
- `reviewer` — self-review completed inline during debug cycles:
  - Found & fixed a global pnpm `send` override that pulled send@1.x and broke express 4.21's `send.mime.charsets` expectation → scoped overrides to the minimal set (`express>path-to-regexp`, `multer`, `@remix-run/router`).
  - Found & fixed `tsx` / vitest decorator metadata gap → added `unplugin-swc` to vitest configs; dev runs compile via `tsc` + `node dist/main.js`.
  - Swapped login order so account lockout (423) takes precedence over per-email rate limit (429) — the sliding window would otherwise mask AUTH_ACCOUNT_LOCKED.
  - Redact rules expanded to include top-level `password|passwordHash|tokenHash|refreshRaw|refreshToken` paths (not just nested).
  - `RedisLifecycle` added so the ioredis client quits on app shutdown; previously tests saw reconnect storms.
- `release-manager` — one feature branch `feat/task-001-auth`, PR prepared.
