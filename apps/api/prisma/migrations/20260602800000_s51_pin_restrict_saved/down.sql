-- Reverse of S51 핀 권한 토글 + 개인 저장함.
--
-- 역순으로 되돌린다: (1) SavedMessage 테이블 DROP(FK·인덱스는 테이블과 함께 사라짐),
-- (2) SaveStatus enum DROP — ★의존 테이블/컬럼 DROP 이후라야 안전(enum 을 참조하는
-- SavedMessage.status 가 이미 사라진 상태), (3) Channel.memberCanPin 컬럼 DROP.
-- 전 단계 IF EXISTS 가드. additive 신규 테이블/컬럼이라 다운그레이드 손실은 저장함
-- 데이터 + 핀 권한 설정에 한정된다(기존 Channel/Message/User 행은 무영향).

DROP TABLE IF EXISTS "SavedMessage";

DROP TYPE IF EXISTS "SaveStatus";

ALTER TABLE "Channel" DROP COLUMN IF EXISTS "memberCanPin";
