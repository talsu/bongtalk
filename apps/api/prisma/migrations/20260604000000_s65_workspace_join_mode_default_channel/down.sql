-- Reverse of S65 워크스페이스 가입 방식 + 이메일 도메인 화이트리스트 + 기본 채널.
--
-- 역순으로 되돌린다: (1) Channel.isDefault 컬럼 DROP, (2) Workspace 의 defaultChannelId
-- 인덱스 → FK → 컬럼 DROP, (3) emailDomains/joinMode 컬럼 DROP, (4) WorkspaceJoinMode
-- enum TYPE DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 신규 enum 이므로 완전 가역: 컬럼(Workspace.joinMode)을 먼저 DROP 한 뒤 enum 을
--   참조하는 객체가 없어 DROP TYPE 이 성공한다(S61 의 enum-값-추가 비대칭과 다름).
-- additive 신규 컬럼/enum 이라 다운그레이드 손실은 가입 방식/이메일 도메인/기본 채널
-- 설정에 한정된다(기존 Workspace/Channel 행·visibility·category 는 무영향).

-- (1) Channel.isDefault 제거.
ALTER TABLE "Channel"
  DROP COLUMN IF EXISTS "isDefault";

-- (2) Workspace.defaultChannelId 의 인덱스 → FK → 컬럼 제거.
DROP INDEX IF EXISTS "Workspace_defaultChannelId_idx";

ALTER TABLE "Workspace"
  DROP CONSTRAINT IF EXISTS "Workspace_defaultChannelId_fkey";

ALTER TABLE "Workspace"
  DROP COLUMN IF EXISTS "defaultChannelId";

-- (3) emailDomains / joinMode 컬럼 제거.
ALTER TABLE "Workspace"
  DROP COLUMN IF EXISTS "emailDomains",
  DROP COLUMN IF EXISTS "joinMode";

-- (4) WorkspaceJoinMode enum TYPE 제거(이제 참조하는 컬럼이 없다).
DROP TYPE IF EXISTS "WorkspaceJoinMode";
