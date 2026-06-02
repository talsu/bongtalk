-- S46 down — NotifLevel enum + UserSettings + ServerNotificationPref +
-- UserChannelMute.level 제거(reversible).
--
-- 순서 주의: UserChannelMute.level 컬럼과 두 신규 테이블(UserSettings·
-- ServerNotificationPref)이 NotifLevel enum 타입을 참조하므로, enum 을 가장 마지막에
-- DROP 한다. enum 에 종속한 객체가 살아있는 채로 DROP TYPE 하면 "cannot drop type
-- ... because other objects depend on it" 로 실패한다.
--
-- 신규 테이블의 FK·인덱스는 DROP TABLE 과 함께 사라지므로 별도 DROP 불요.
-- UserChannelMute.level 은 additive 컬럼이라 DROP COLUMN 만으로 원복된다(기존
-- 뮤트 행 자체는 보존 — level 만 사라짐). 글로벌/서버 설정 데이터는 다운그레이드
-- 시 두 테이블과 함께 소실되나(이 슬라이스 신규 데이터에 한정), 기존
-- User/Workspace/UserChannelMute 행은 무영향이다.

-- 4 → 3 → 2 → 1: 컬럼 → 테이블 → enum 역순.
ALTER TABLE "UserChannelMute"
  DROP COLUMN IF EXISTS "level";

DROP TABLE IF EXISTS "ServerNotificationPref";

DROP TABLE IF EXISTS "UserSettings";

DROP TYPE IF EXISTS "NotifLevel";
