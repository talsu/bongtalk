-- Reverse of task-019-C preference column add.
ALTER TABLE "User" DROP COLUMN IF EXISTS "presencePreference";
DROP TYPE IF EXISTS "PresencePreference";
