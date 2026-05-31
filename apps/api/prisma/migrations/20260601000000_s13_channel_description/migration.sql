-- S13 (D02 채널 설명) — FR-CH-10 채널 설명(description) 컬럼 + 전문검색 인덱스.
--
-- 두 가지 변경:
--  1) Channel 에 description VARCHAR(500) 추가 (nullable, additive).
--  2) description 전문검색용 GIN 인덱스를 to_tsvector 식(expression) 기반으로
--     생성. config 는 'simple' — 언어별 스테밍 가정 없이(한국어 본문 포함)
--     토큰화만 수행해 결정적이고 unaccent/언어 확장 의존성이 없다.
--     (검색 쿼리 자체는 D07 search 영역. 여기서는 컬럼+인덱스만 둔다.)
--
-- additive: 컬럼은 NULL 허용 기본값 없음 → 기존 행 영향 없음(즉시 NULL).
-- reversible: down.sql 이 인덱스 → 컬럼 순으로 되돌린다.

-- 1) description 컬럼 (nullable, ≤500자는 애플리케이션 zod 가 강제, DB 는 길이 상한)
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "description" VARCHAR(500);

-- 2) 전문검색 GIN 인덱스 (description 식 기반)
CREATE INDEX IF NOT EXISTS "Channel_description_fts_idx"
  ON "Channel"
  USING GIN (to_tsvector('simple', coalesce("description", '')));
