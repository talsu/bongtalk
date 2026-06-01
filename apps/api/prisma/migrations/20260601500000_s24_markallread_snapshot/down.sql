-- S24 (FR-RS-18) down — 대칭 역순 DROP. 인덱스는 DROP TABLE 이 함께 제거하지만
-- 명시적으로 먼저 떨군 뒤 테이블을 떨궈 의도를 드러낸다. 스냅샷은 Undo 윈도
-- (5분/expiresAt) 한정 파생 데이터라 손실 무해.
DROP INDEX IF EXISTS "MarkAllReadSnapshot_expiresAt_idx";
DROP INDEX IF EXISTS "MarkAllReadSnapshot_userId_workspaceId_idx";
DROP TABLE IF EXISTS "MarkAllReadSnapshot";
