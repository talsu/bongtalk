-- S03 down — reverse the USER-scope idempotency index + nonce column.
-- The legacy channel-scope index was never dropped in up.sql, so nothing
-- to recreate here; reversing only the additive changes restores the prior
-- (channel-scoped) idempotency behaviour exactly.
--
-- ⚠️ SAFETY PRECONDITION (S03 review MAJOR #3): this down is valid ONLY while
-- the legacy `Message_authorId_channelId_idempotencyKey_unique` index is still
-- live (i.e. the future CONTRACT slice that DROPs it has NOT run). If that
-- CONTRACT slice has already run, this down would leave the `Message` table
-- with NO idempotency unique index at all. The CONTRACT slice's OWN down must
-- recreate the legacy channel-scope index — do not rely on this file to do it.

DROP INDEX IF EXISTS "Message_authorId_idempotencyKey_unique";

ALTER TABLE "Message" DROP COLUMN IF EXISTS "nonce";
