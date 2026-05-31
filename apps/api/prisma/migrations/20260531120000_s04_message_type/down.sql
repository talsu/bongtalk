-- S04 reversible down — 역방향(롤백) 마이그레이션.
--
-- 순수 additive 였으므로 비파괴적으로 원복한다. 신규 컬럼/enum 만 제거하며
-- 기존 컬럼은 건드리지 않는다.
--
-- 주의: up 적용 이후 SYSTEM_* 타입 메시지가 생성됐다면 down 은 그 행의 type
-- 구분 정보를 버린다(컬럼 자체 제거). 라이브 롤백 전 시스템 메시지 보존
-- 여부를 확인할 것.

-- AlterTable (컬럼 제거)
ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "type";

-- DropEnum (컬럼 제거 후 타입 제거)
DROP TYPE IF EXISTS "MessageType";
