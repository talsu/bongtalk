-- task-045 iter4: User.customStatus (VARCHAR(100) nullable).
-- Discord-parity 자유 문자열 status. emoji prefix / WS broadcast 는
-- follow-up. Reversible: DROP COLUMN.

ALTER TABLE "User" ADD COLUMN "customStatus" VARCHAR(100);
