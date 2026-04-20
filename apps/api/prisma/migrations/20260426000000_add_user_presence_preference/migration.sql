-- Task-019-C: user-facing DnD toggle.
--
-- `presencePreference` joins `presenceStatus` (runtime, Redis-driven) as
-- the static preference the WS gateway reads at connect time to pick the
-- initial online/dnd state. "auto" preserves 005 semantics (online on
-- connect, offline on disconnect). "dnd" means connect-time shows dnd
-- instead of online; disconnect still goes to offline.
--
-- The column is NOT NULL with a DEFAULT so the ALTER is
-- metadata-only — no table rewrite, no downtime on the live NAS
-- even with thousands of rows. Future states (e.g. "invisible") can
-- be layered in as additional enum values without breaking existing
-- rows thanks to the text representation + app-level validation.

CREATE TYPE "PresencePreference" AS ENUM ('auto', 'dnd');

ALTER TABLE "User"
  ADD COLUMN "presencePreference" "PresencePreference" NOT NULL DEFAULT 'auto';
