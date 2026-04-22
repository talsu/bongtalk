-- task-027: add DIRECT to ChannelType enum for 1:1 direct messages.
-- Reversible caveat: Postgres doesn't support dropping a single enum
-- value once any row uses it. Down-migration strategy: first set all
-- DIRECT rows to a different type (or soft-delete), then recreate the
-- enum. Not scripted here — documented so ops knows the path.

ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'DIRECT';
