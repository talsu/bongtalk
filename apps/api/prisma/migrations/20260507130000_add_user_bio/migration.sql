-- task-046 iter5 (M1): User.bio (TEXT nullable, max 500 chars enforced at app layer).
-- Discord-parity profile bio. links 는 markdown URL 로 contained — User.links
-- 은 별도 column 추가 안 함 (bio 안에 markdown 으로 표현 가능).
-- Reversible: DROP COLUMN.

ALTER TABLE "User" ADD COLUMN "bio" TEXT;
