-- task-078 down — OAuthClient 레지스트리 롤백(reversible).
--
-- OAuthClient 는 전부 신규 additive 자산이라 DROP 으로 원천 데이터를 잃지 않는다(RP 메타는
-- 시드/관리 API 로 재등록 가능). 인덱스·PK 는 테이블과 함께 사라지므로 테이블 1개만 DROP.

DROP TABLE IF EXISTS "OAuthClient";
