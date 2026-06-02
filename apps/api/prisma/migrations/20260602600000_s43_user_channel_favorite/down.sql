-- Reverse of S43 채널 즐겨찾기.
--
-- 신규 테이블 1개라 down = DROP TABLE. 테이블의 FK(userId/channelId)·인덱스
-- (unique + position)는 DROP TABLE 과 함께 사라지므로 별도 DROP 불요. additive
-- 신규 테이블이라 다운그레이드 후 데이터 손실은 이 테이블에 한정된다(기존
-- User/Channel 행은 무영향).

DROP TABLE IF EXISTS "UserChannelFavorite";
