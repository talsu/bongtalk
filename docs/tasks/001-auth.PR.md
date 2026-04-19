# feat(auth): signup/login/refresh with token rotation (task-001)

## Summary
- Production auth spine: signup/login/refresh/logout/me, argon2id + zxcvbn, JWT access (15m) + opaque refresh (7d, SHA-256 at rest).
- **Refresh rotation + reuse detection**: replaying a rotated token burns the entire `familyId`, emits `auth.session.compromised`, and responds `401 AUTH_SESSION_COMPROMISED`.
- IP (10/min) + email (5/15min) rate limits, 5-strike 15-minute lockout (423 AUTH_ACCOUNT_LOCKED takes precedence over 429).
- Global `JwtAuthGuard` (`APP_GUARD`) + `@Public()` + `@CurrentUser()`; HttpOnly + SameSite=Strict refresh cookie on `/auth`; Origin-header check on refresh/logout.
- Frontend: AuthProvider, login/signup pages (react-hook-form + Zod), ProtectedRoute, API client with in-memory access token + single-retry refresh on 401.

## API Changes
| Method | Path | Status codes |
|---|---|---|
| POST | `/auth/signup` | 201 / 400 VALIDATION_FAILED / 409 AUTH_EMAIL_TAKEN / 409 AUTH_USERNAME_TAKEN / 422 AUTH_WEAK_PASSWORD |
| POST | `/auth/login` | 200 / 401 AUTH_INVALID_CREDENTIALS / 423 AUTH_ACCOUNT_LOCKED / 429 RATE_LIMITED |
| POST | `/auth/refresh` | 200 / 401 AUTH_INVALID_TOKEN / 401 AUTH_SESSION_COMPROMISED |
| POST | `/auth/logout` | 204 |
| GET  | `/auth/me` | 200 / 401 AUTH_INVALID_TOKEN |

Error codes added: `AUTH_EMAIL_TAKEN`, `AUTH_USERNAME_TAKEN`, `AUTH_WEAK_PASSWORD`, `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_LOCKED`, `AUTH_SESSION_COMPROMISED`.

## DB Migrations
`apps/api/prisma/migrations/20260419060420_add_auth_refresh_tokens/migration.sql`
- `RefreshToken(id, userId, tokenHash UNIQUE, familyId, parentId, userAgent, ip, expiresAt, revokedAt, replacedAt, createdAt)` + indexes on `userId`, `familyId`, `expiresAt`.
- `User` gains `passwordHash`, `lastLoginAt`, `failedLoginAttempts`, `lockedUntil`.
- Migration is reversible in theory (DROP RefreshToken + drop User columns); destructive path requires explicit approval per db-migrator policy.

## Security Considerations
| Requirement | Where |
|---|---|
| argon2id, zxcvbn ≥ 3, ≥ 10 chars + 3 classes | `apps/api/src/auth/services/password.service.ts` |
| Timing-attack parity (dummyVerify on missing email) | same file |
| Opaque 32B refresh, SHA-256 at rest, rotation, reuse detection | `apps/api/src/auth/services/token.service.ts` |
| Redis sliding window + lockout | `rate-limit.service.ts` + `auth.service.login` |
| HttpOnly + Secure (prod) + SameSite=Strict + Path=/auth cookie | `auth.controller.ts::setRefreshCookie` |
| Origin whitelist (CORS_ORIGINS env) on refresh/logout | `auth.controller.ts::ensureAllowedOrigin` |
| helmet + cookie-parser | `main.ts` |
| Pino redact (password, tokenHash, passwordHash, refreshRaw, cookie) | `common/logging/logger.ts` + unit test |
| `session-compromised` event (EventEmitter2) | `auth/events/session-compromised.event.ts` |
| Global default-deny JwtAuthGuard + @Public | `auth/guards/jwt-auth.guard.ts` |

## Test Evidence
- `pnpm -w run verify` → exit 0 (16/16 turbo tasks, 20 unit tests across shared-types/api/web)
- `pnpm --filter @qufox/api test:int` → 17/17 tests, 16s (includes refresh reuse detection)
- `pnpm test:e2e` (dockerized Playwright) → 4/4 tests (signup-login-logout, token-refresh, session-compromise, smoke)
- `pnpm smoke` → healthz/readyz + signup → /me → login → logout cURL flow exit 0
- `pnpm audit --prod --audit-level=high` → **0 high/critical** (1 low, 4 moderate remain; see follow-ups)
- `pnpm eval -- --dry-run` → 4/4 tasks parse, includes new `004-auth-refresh-rotation.yaml`
- `pnpm debug:dump` → `./.debug/latest.json` shows DB counts (User:2, Channel:2, Message:5), redis ok

## Follow-ups
- `TODO(task-005)`: `@socket.io/redis-adapter` wiring; JWT handshake for realtime gateway
- `TODO(task-009)`: OAuth / social login
- `TODO(task-010)`: 2FA / TOTP
- `TODO(task-011)`: password reset + password-history prevention
- `TODO(task-012)`: email verification
- `TODO(task-013)`: session management UI ("my sessions" list)
- Open moderates from `pnpm audit --prod`: 4 (transitive, accepted for Phase 1; tracked in Dependabot).
- Reviewer notes in `docs/tasks/001-auth.md` Progress Log.
