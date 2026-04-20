-- Task-014-B: single-level message threads. Self-FK on Message with
-- ON DELETE SET NULL so a hard-deleted root (purge worker only) turns
-- its replies into pseudo-roots instead of cascade-nuking them.
--
-- Single-level depth is enforced at the service layer — parent.parent
-- IS NULL is asserted per write. Triggerless by design.
--
-- Partial index on `(channelId, createdAt DESC) WHERE parentMessageId IS NULL`
-- lets the roots-only channel list stay on an index scan even when
-- replies outnumber roots 10:1. The sibling index
-- `(parentMessageId, createdAt ASC)` feeds the thread replies page.
--
-- Indexes use CREATE INDEX CONCURRENTLY in production to avoid AccessExclusive
-- on the messages table; Prisma migrations can't run CONCURRENTLY inside the
-- implicit transaction, so a deploy-time hook script has to run those two
-- CREATE INDEX CONCURRENTLY statements against the populated DB.
-- For dev / test / fresh migrate the plain index here is fine.

ALTER TABLE "Message"
  ADD COLUMN "parentMessageId" UUID NULL
    REFERENCES "Message"("id") ON DELETE SET NULL;

-- Roots-only channel list (partial index).
CREATE INDEX "Message_channel_roots_idx"
  ON "Message"("channelId", "createdAt" DESC)
  WHERE "parentMessageId" IS NULL;

-- Thread replies fetch (ORDER BY createdAt ASC, paginated by cursor).
CREATE INDEX "Message_parentMessageId_createdAt_idx"
  ON "Message"("parentMessageId", "createdAt");
