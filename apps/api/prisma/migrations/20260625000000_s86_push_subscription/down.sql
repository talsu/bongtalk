-- S86 down — Web Push(VAPID) 구독 테이블 롤백(reversible).
--
-- PushSubscription 은 전부 신규 additive 자산이라 DROP 으로 원천 데이터를 잃지 않는다
-- (구독은 브라우저가 PushManager.subscribe 로 언제든 재생성 가능한 휘발성 등록 메타다).
-- FK·인덱스는 테이블과 함께 사라지므로 테이블 1개만 DROP 한다.

DROP TABLE IF EXISTS "PushSubscription";
