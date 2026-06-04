-- S70 (D13 / FR-W06) down — 완전 가역.
--
-- 신규 enum + 신규 테이블만 더한 additive 마이그레이션이므로, 테이블을 먼저 DROP 한 뒤
-- enum TYPE 을 DROP 해 무손실 역행한다(S65 의 "신규 enum = 완전 가역" 선례). 테이블 DROP
-- 이 FK 제약·인덱스를 함께 제거하므로 별도 DROP 은 불요하다. enum 은 컬럼이 사라진 뒤라야
-- DROP 가능(의존 객체 없음).

DROP TABLE IF EXISTS "WorkspaceMemberApplication";

DROP TYPE IF EXISTS "ApplicationStatus";
