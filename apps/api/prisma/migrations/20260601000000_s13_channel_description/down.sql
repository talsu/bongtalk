-- S13 FR-CH-10 롤백: 인덱스 먼저, 그다음 컬럼.
DROP INDEX IF EXISTS "Channel_description_fts_idx";
ALTER TABLE "Channel" DROP COLUMN IF EXISTS "description";
