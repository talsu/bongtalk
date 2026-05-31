-- S05 reversible down — 역방향(롤백) 마이그레이션.
--
-- 순수 additive(신규 테이블)였으므로 테이블 통째로 제거하면 원복된다.
-- 기존 Message 테이블/컬럼은 건드리지 않는다.
--
-- 주의: up 적용 이후 누적된 편집 이력 스냅샷은 down 으로 모두 소실된다
-- (테이블 자체 제거). 라이브 롤백 전 이력 보존 필요 여부를 확인할 것.
-- FK(MessageEditHistory_messageId_fkey)와 index 는 DROP TABLE 시 함께 제거된다.

DROP TABLE IF EXISTS "MessageEditHistory";
