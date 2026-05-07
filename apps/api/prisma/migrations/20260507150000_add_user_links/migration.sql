-- task-047 iter3 (M2): User.links — Discord-parity profile 외부 URL.
-- shape: Json array of { url, label }. cap 3 (app layer).
-- 새 컬럼이라 빈 테이블 lock 비용 0 — CONCURRENTLY 불필요.
-- Reversible: DROP COLUMN.

ALTER TABLE "User" ADD COLUMN "links" JSONB;
