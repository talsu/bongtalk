-- S11 (FR-RT-14 / FR-RT-19) — read-state message cursor 컬럼 추가.
--
-- expand-contract 안전 규칙: ADDITIVE 만. UserChannelReadState 에 nullable
-- 컬럼 2개만 추가하므로 기존 row / 기존 컬럼은 전혀 건드리지 않는다(회귀 없음).
-- 기존 `lastReadEventId`(reconnect replay 사용)·`lastReadAt`(mention-inbox
-- proxy 사용) 컬럼은 보존한다(drop 금지).
--
-- 설계 근거: Message.id 는 `@default(uuid())` 랜덤 UUID(비정렬)라 `id >`
-- 문자열 비교가 메시지 순서와 무관하다. 따라서 읽음 커서는 메시지 커서
-- 페이지네이션과 동일한 (createdAt, id) 튜플로 비교한다. 두 컬럼 모두
-- nullable — 기존 row + 새로 가입한 채널은 NULL 로 back-fill 되어 "전체
-- 미읽음" 으로 해석된다(의도된 UX). seed 결정성 무관.
--
-- Reversible: down.sql 동반(컬럼 DROP — 데이터는 파생값이라 손실 무해).

-- AlterTable
ALTER TABLE "UserChannelReadState"
    ADD COLUMN "lastReadMessageId" UUID,
    ADD COLUMN "lastReadMessageCreatedAt" TIMESTAMPTZ;
