-- task-020-A (reviewer HIGH fix): OutboxHealthIndicator runs
-- `COUNT(*) WHERE dispatchedAt IS NULL AND occurredAt < $cutoff` on
-- every /readyz poll. The existing compound index
-- `@@index([dispatchedAt, occurredAt])` is a full B-tree — acceptable
-- but with a growing outbox it starts scanning the entire
-- dispatchedAt=false bucket before filtering by occurredAt.
--
-- A partial index whose body is ONLY the undispatched rows keeps the
-- planner on a bounded index scan. /readyz is called every 2 s by the
-- auto-deploy health-wait gate plus external monitors; minimising
-- the query's index size is the right optimisation target.
--
-- CREATE INDEX CONCURRENTLY would not hold a write lock, but Prisma
-- migrate deploy does not accept it inside a transaction (Prisma wraps
-- DDL). The migration is non-blocking in practice because the target
-- table is narrow and partial index builds on small subsets are quick;
-- if future size makes this painful, this migration can be split into
-- a manual concurrent-index bootstrap + an empty Prisma migration.
CREATE INDEX "OutboxEvent_undispatched_occurredAt_idx"
  ON "OutboxEvent"("occurredAt")
  WHERE "dispatchedAt" IS NULL;
