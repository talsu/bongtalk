-- Task-019-D: per-user per-workspace notification delivery channel.
--
-- Shape mirrors the task contract:
--   (userId, workspaceId NULLABLE, eventType) → channel
--
-- workspaceId NULL means "global default for this user". The
-- dispatcher resolves (userId, ws, ev) first, then (userId, null, ev),
-- then falls back to a hardcoded default. Uniqueness is enforced by
-- two partial unique indexes — Postgres treats NULLs as distinct in
-- a regular UNIQUE so we need a coalesce or partial index trick. We
-- pick the partial approach because it's clearer at EXPLAIN time.

CREATE TYPE "NotificationEventType" AS ENUM ('MENTION', 'REPLY', 'REACTION', 'DIRECT');
CREATE TYPE "NotificationChannel"   AS ENUM ('TOAST', 'BROWSER', 'BOTH', 'OFF');

CREATE TABLE "UserNotificationPreference" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"      UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "workspaceId" UUID REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "eventType"   "NotificationEventType" NOT NULL,
  "channel"     "NotificationChannel"   NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two partial unique indexes: one for workspace-scoped rows, one for
-- the global (workspaceId IS NULL) row. Both combined make
-- (userId, workspaceId, eventType) unique for any workspaceId value
-- including NULL.
CREATE UNIQUE INDEX "UserNotificationPreference_user_ws_ev_uniq"
  ON "UserNotificationPreference"("userId", "workspaceId", "eventType")
  WHERE "workspaceId" IS NOT NULL;

CREATE UNIQUE INDEX "UserNotificationPreference_user_global_ev_uniq"
  ON "UserNotificationPreference"("userId", "eventType")
  WHERE "workspaceId" IS NULL;

-- Dispatcher lookup hot path — one row per (userId, eventType) per
-- lookup. The partial indexes above cover writes; this index covers
-- the dispatcher's read hot path.
CREATE INDEX "UserNotificationPreference_user_ev_idx"
  ON "UserNotificationPreference"("userId", "eventType");

-- Settings page load: one query pulls every pref for the user.
CREATE INDEX "UserNotificationPreference_user_ws_idx"
  ON "UserNotificationPreference"("userId", "workspaceId");
