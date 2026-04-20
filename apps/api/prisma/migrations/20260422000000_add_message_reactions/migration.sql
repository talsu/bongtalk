-- Task-013-B: per-message reactions.
--
-- `emoji` stores the literal unicode string (single codepoint, flag
-- pair, ZWJ sequence), bounded at 64 chars for DB safety; the API
-- enforces a ≤4 codepoint cap on top. Uniqueness on
-- (messageId, userId, emoji) makes the `add reaction` endpoint
-- naturally idempotent — a retry returns the existing row.
--
-- Cascade on Message + User delete so soft-delete flows don't
-- strand reaction rows.

CREATE TABLE "MessageReaction" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "messageId" UUID NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
  "userId"    UUID NOT NULL REFERENCES "User"("id")    ON DELETE CASCADE,
  "emoji"     VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "MessageReaction_unique"
  ON "MessageReaction"("messageId", "userId", "emoji");

-- Feeds the GROUP BY count + byMe-check on the messages GET path.
CREATE INDEX "MessageReaction_messageId_emoji_idx"
  ON "MessageReaction"("messageId", "emoji");
