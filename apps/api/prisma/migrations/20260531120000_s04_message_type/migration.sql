-- S04 (ADR-2 / FR-MSG-19 / FR-RC10) — MessageType enum + Message.type 컬럼.
--
-- expand-contract 안전 규칙: ADDITIVE 만. `type` 은 NOT NULL DEFAULT 'DEFAULT'
-- 라 라이브 DB 의 기존 row 가 즉시 'DEFAULT' 로 채워진다(기존 동작 회귀 없음).
-- 새 enum 타입 1개 + 컬럼 1개만 추가하므로 lock 비용이 작다.
--
-- 값 집합은 packages/shared-types/src/message-type.ts(단일 출처)와 1:1 동기화.
-- SYSTEM_* 는 authorType=SYSTEM, grouped=false 강제, 편집·삭제 UI 미표시
-- (렌더링 규칙은 클라이언트가 type 으로 분기).
--
-- Reversible: down.sql 동반(컬럼 DROP + enum DROP).

-- CreateEnum (ADR-2 단일 카노니컬 MessageType).
CREATE TYPE "MessageType" AS ENUM (
  'DEFAULT',
  'SYSTEM_MEMBER_JOINED',
  'SYSTEM_MEMBER_LEFT',
  'SYSTEM_MEMBER_BANNED',
  'SYSTEM_PIN',
  'SYSTEM_CHANNEL_RENAME',
  'SYSTEM_CHANNEL_TOPIC_CHANGED',
  'SYSTEM_CHANNEL_ARCHIVED',
  'SYSTEM_THREAD_BROADCAST'
);

-- AlterTable (additive). NOT NULL DEFAULT 'DEFAULT' → 기존 row 자동 채움.
ALTER TABLE "Message"
  ADD COLUMN "type" "MessageType" NOT NULL DEFAULT 'DEFAULT';
