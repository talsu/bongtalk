-- FR-P09 fix-forward (perf · task-068 · S95): MemberRole 에 (workspaceId, roleId) 복합
-- 인덱스를 추가한다.
--
-- listGrouped 의 hoist assignment 조회는 `WHERE workspaceId = $1 AND roleId IN (...)`
-- 형태다. 종전 @@index([roleId]) 단독은 roleId IN 만 커버하고 workspaceId 선행 필터를
-- 인덱스로 좁히지 못했다(특히 LARGE 경로에서 워크스페이스 전체 hoisted assignment 를
-- 훑었다). (workspaceId, roleId) 복합 인덱스로 두 조건을 한 번에 커버한다.
--
-- 소형 비-CONCURRENT 인덱스 생성(MemberRole 은 조인 테이블이라 행 수가 워크스페이스
-- 멤버×역할 수준 — 트랜잭션 안 락 시간이 짧다). forward-safe·additive.
CREATE INDEX "MemberRole_workspaceId_roleId_idx" ON "MemberRole"("workspaceId", "roleId");

-- reversible: down migration =
--   DROP INDEX "MemberRole_workspaceId_roleId_idx";
-- 인덱스만 추가하므로 데이터 변경이 없고, DROP INDEX 로 완전히 되돌아간다.
