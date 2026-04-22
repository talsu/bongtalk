-- task-026: UserActivityReadState — tracks per-user read state of
-- Activity inbox rows (mentions / replies / reactions). Reversible:
-- a single new table + indexes + FK, dropping it restores prior state.

CREATE TABLE "UserActivityReadState" (
  "id"          uuid PRIMARY KEY,
  "userId"      uuid NOT NULL,
  "activityKey" text NOT NULL,
  "readAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL,

  CONSTRAINT "UserActivityReadState_userId_activityKey_key"
    UNIQUE ("userId", "activityKey"),

  CONSTRAINT "UserActivityReadState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

-- Hot path: load + read-all for a user, newest first.
CREATE INDEX "UserActivityReadState_userId_readAt_idx"
  ON "UserActivityReadState"("userId", "readAt" DESC);
