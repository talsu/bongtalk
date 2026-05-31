-- S01 reversible down — 역방향(롤백) 마이그레이션.
--
-- 이 슬라이스는 순수 additive 였으므로 down 은 비파괴적으로 원복한다.
-- 신규 컬럼/인덱스/enum 만 제거하며, 기존 `content` / `contentPlain` 등
-- 기존 컬럼은 애초에 건드리지 않았으므로 복원 작업이 없다.
--
-- 주의: 적용(up) 이후 신규 컬럼에 데이터가 쌓였다면 down 은 그 데이터를
-- 버린다(additive 컬럼 한정). 라이브 롤백 전에는 백필 데이터 보존 여부를
-- 확인할 것.

-- DropIndex
DROP INDEX IF EXISTS "Message_channelId_id_idx";

-- AlterTable (신규 컬럼 제거 — 역순)
ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "authorType",
  DROP COLUMN IF EXISTS "seq",
  DROP COLUMN IF EXISTS "version",
  DROP COLUMN IF EXISTS "contentPlainV2",
  DROP COLUMN IF EXISTS "contentAst",
  DROP COLUMN IF EXISTS "contentRaw";

-- DropEnum (컬럼 제거 후에 타입 제거)
DROP TYPE IF EXISTS "AuthorType";
