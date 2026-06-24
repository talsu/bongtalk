-- task-078 P2-acl down — OAuthClientAccess 롤백(reversible).
-- 전부 신규 additive 자산(승인 메타는 관리 UI/스크립트로 재등록 가능). FK·인덱스는 테이블과
-- 함께 사라지므로 테이블 1개만 DROP.

DROP TABLE IF EXISTS "OAuthClientAccess";
