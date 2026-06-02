-- S36 down — ThreadReadState 테이블 제거(reversible).
--
-- 신규 additive 테이블이라 DROP TABLE 한 방으로 완전 원복된다(기존 row 영향
-- 없었으므로 backfill 역연산도 불필요). 인덱스/FK 는 테이블에 종속되므로 별도
-- DROP 없이 CASCADE 로 함께 정리된다.
DROP TABLE IF EXISTS "ThreadReadState" CASCADE;
