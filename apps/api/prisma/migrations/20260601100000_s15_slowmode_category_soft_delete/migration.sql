-- S15 (D02 채널 브라우저/카테고리/slowmode) — FR-CH-08 + FR-CH-12.
--
-- 세 가지 변경:
--  1) Channel 에 slowmodeSeconds INT NOT NULL DEFAULT 0 추가 (FR-CH-08).
--     송신 경로가 Redis TTL 로 집행하며, 0 이면 게이트 무동작.
--  2) Category 에 deletedAt TIMESTAMP NULL 추가 (FR-CH-12 soft-delete).
--  3) Category 의 전체-테이블 UNIQUE(workspaceId,name) 를 활성 행 한정 부분
--     유니크 `WHERE "deletedAt" IS NULL` 로 교체. soft-delete 된 카테고리는
--     이름을 더 이상 점유하지 않으므로 삭제 즉시 동명 재사용이 가능하다
--     (S12 채널 partial-unique 와 동일 패턴).
--
-- additive + index swap: (1)(2) 는 NOT NULL DEFAULT / NULL 컬럼이라 기존 행
-- 영향 없음. (3) 은 활성(deletedAt IS NULL) 카테고리의 유니크 보장을 끊김 없이
-- 유지한다(부분 인덱스가 전체 인덱스의 활성 부분집합). reversible: down.sql 동반.

-- 1) slowmodeSeconds 컬럼
ALTER TABLE "Channel"
  ADD COLUMN IF NOT EXISTS "slowmodeSeconds" INTEGER NOT NULL DEFAULT 0;

-- 2) Category soft-delete 컬럼 + 인덱스
ALTER TABLE "Category"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Category_workspaceId_deletedAt_idx"
  ON "Category"("workspaceId", "deletedAt");

-- 3) 전체-테이블 유니크 제거 → 활성 카테고리 한정 부분 유니크로 교체
DROP INDEX IF EXISTS "Category_workspaceId_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Category_workspaceId_name_active_uniq"
  ON "Category"("workspaceId", "name")
  WHERE "deletedAt" IS NULL;
