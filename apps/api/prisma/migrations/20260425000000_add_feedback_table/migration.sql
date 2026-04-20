-- Task-016-C-3: user-submitted beta feedback.
--
-- Lives as a plain table (no soft-delete — feedback is discardable by
-- design; operators curate via `DELETE FROM Feedback WHERE ...` when
-- volume justifies triage tooling). FK to User / Workspace ON DELETE
-- SET NULL so a GDPR-style user purge preserves the aggregate
-- feedback row with authorship anonymized.
--
-- `content` cap 2000 chars — matches the API-layer validator. DB-
-- level CHECK gives defense-in-depth against a bypass.
--
-- Indexes: `(createdAt DESC)` for the operator's
-- `ORDER BY createdAt DESC LIMIT 50` queue, `(userId, createdAt DESC)`
-- for per-user rate-limit auditing and GDPR export.

CREATE TYPE "FeedbackCategory" AS ENUM ('BUG', 'FEATURE', 'OTHER');

CREATE TABLE "Feedback" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"      UUID         REFERENCES "User"("id")      ON DELETE SET NULL,
  "workspaceId" UUID         REFERENCES "Workspace"("id") ON DELETE SET NULL,
  "category"    "FeedbackCategory" NOT NULL,
  "content"     TEXT         NOT NULL CHECK (char_length("content") <= 2000),
  "page"        TEXT,
  "userAgent"   TEXT,
  "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX "Feedback_createdAt_desc_idx"
  ON "Feedback" ("createdAt" DESC);

CREATE INDEX "Feedback_user_createdAt_idx"
  ON "Feedback" ("userId", "createdAt" DESC);
