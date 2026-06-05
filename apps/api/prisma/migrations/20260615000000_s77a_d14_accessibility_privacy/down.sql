-- Reverse of S77a (D14 / FR-PS-12·13) — 접근성 + 프라이버시 설정.
--
-- 역순으로 되돌린다: (1) UserSettings 의 additive 컬럼 5개 DROP, (2) FriendReqPolicy
-- enum TYPE DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: 신규 enum 1개 + additive 컬럼 5개라 다운그레이드 손실은 접근성/프라이버시
--   값에 한정된다. 기존 DM 권한(User.allowDmFrom)·친구관계·메시징·외관·알림은 무영향
--   (이 마이그레이션이 손대지 않음). enum 을 참조하는 컬럼이 남아 있으면 DROP TYPE 이
--   실패하므로 컬럼을 먼저 DROP 한 뒤 enum 을 DROP 한다(순서가 중요).

-- (1) UserSettings additive 컬럼 제거(추가 역순).
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "allowFriendRequests";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "messageRequestEnabled";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "allowDmFromWorkspaceMembers";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "highContrast";
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "reduceMotion";

-- (2) 신규 enum TYPE 제거(참조 컬럼이 모두 사라진 뒤이므로 안전).
DROP TYPE IF EXISTS "FriendReqPolicy";
