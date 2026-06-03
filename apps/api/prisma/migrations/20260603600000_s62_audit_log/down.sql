-- S62 (D12 / FR-RM17) — AuditLog 역마이그레이션.
--
-- up 이 신규 테이블만 추가했으므로 down 은 그 테이블(FK·인덱스 포함)을 통째로 DROP
-- 한다. DROP TABLE 이 종속 인덱스·제약을 함께 제거하므로 추가 DROP INDEX 는 불필요
-- 하나, 멱등성을 위해 IF EXISTS 로 감싼다. 데이터 손실(감사 로그)은 의도된 역방향
-- 동작이다(테이블 신설을 되돌림).

DROP TABLE IF EXISTS "AuditLog";
