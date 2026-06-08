-- FR-P09 (task-068 · S95): Role.hoistInMemberList 플래그 추가 + 시스템 역할 backfill.
--
-- 역할 hoistInMemberList=true 면 그 역할 멤버(온라인)가 멤버 목록 상단에 별도 그룹으로
-- 표시된다(Discord hoist). 종전 S27 은 커스텀 Role 부재로 OWNER/ADMIN 을 단일
-- '운영진'(staff) 그룹으로 하드코딩(HOISTED_ROLES 상수)했다. S61 커스텀 Role 로 차단이
-- 해소되어 역할 기반 동적 hoist 로 전환한다(per-role 그룹).
--
-- 1) 컬럼 추가: NOT NULL DEFAULT false 라 기존 모든 Role 행은 즉시 false 로 채워지고,
--    커스텀 역할 및 MODERATOR/MEMBER/GUEST 시스템 역할은 비-hoist 로 시작한다.
ALTER TABLE "Role" ADD COLUMN "hoistInMemberList" boolean NOT NULL DEFAULT false;

-- 2) backfill: 기존 '운영진' 동작(OWNER/ADMIN hoist)을 회귀 없이 보존한다.
--    시스템 역할 식별은 isSystem=true + name IN ('OWNER','ADMIN') 로 한다 — name 은
--    @@unique([workspaceId,name]) 로 워크스페이스 내 유일하고 SYSTEM_ROLE_NAMES 리터럴과
--    정확히 1:1 대응하므로 가장 정확하다(position 500/400 은 커스텀 역할도 가질 수 있어
--    덜 안전). MODERATOR/MEMBER/GUEST 시스템 역할 + 모든 커스텀 역할은 false 로 유지된다.
--    멱등: 컬럼이 방금 false 로 초기화되었고 이 UPDATE 는 동일 조건에서 항상 같은 결과라
--    재실행해도 안전하다(forward-safe).
UPDATE "Role"
SET "hoistInMemberList" = true
WHERE "isSystem" = true AND "name" IN ('OWNER', 'ADMIN');

-- reversible: down migration =
--   ALTER TABLE "Role" DROP COLUMN "hoistInMemberList";
-- NOT NULL DEFAULT false + 단순 UPDATE 라 컬럼만 떨어뜨리면 backfill 흔적 없이 완전히
-- 되돌아간다(additive · 데이터 손실 없음).
