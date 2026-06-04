-- S65 fix-forward (perf MODERATE-1) — Channel.isDefault 부분 인덱스.
--
-- updateDefaultChannel(FR-W19)은 매 기본 채널 변경마다
--   UPDATE "Channel" SET "isDefault"=false
--   WHERE "workspaceId"=$1 AND "isDefault"=true AND "id" <> $2
-- 를 실행한다. 워크스페이스당 isDefault=true 인 행은 보통 0~1개뿐이므로,
-- (workspaceId, isDefault) 전체 인덱스 대신 WHERE "isDefault"=true 부분 인덱스로
-- 두면 대부분 false 인 행을 인덱스에서 제외해 매우 작고 저렴한 인덱스로 그 updateMany
-- 의 대상 행 탐색을 직접 가속한다. Prisma @@index 는 부분 인덱스(WHERE)를 표현할 수
-- 없어 raw SQL 마이그레이션으로만 둔다(s13 description GIN, s34 DIRECT 부분 unique
-- 선례와 동일 패턴).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 는 migration.sql 을 단일 트랜잭션으로
--   실행하므로 트랜잭션 블록에서 금지되는 CREATE INDEX CONCURRENTLY 를 쓰지 않는다.
--   isDefault=true 부분집합이 작아(워크스페이스당 ≤1행) 일반 CREATE INDEX 의 짧은
--   ACCESS EXCLUSIVE 락도 사실상 무시할 수준이다.
-- ★ IF NOT EXISTS 가드로 멱등화(s51/s53/s54/s55/s60/s61/s65 패턴 일관). reversible —
--   down.sql 이 DROP INDEX IF EXISTS 로 완전 가역.

CREATE INDEX IF NOT EXISTS "Channel_workspaceId_isDefault_idx"
  ON "Channel" ("workspaceId", "isDefault")
  WHERE "isDefault" = true;
