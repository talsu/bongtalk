-- S11 rollback — additive 컬럼 2개 DROP. 파생(derived) read-cursor 값이라
-- 손실되어도 다음 ack/markRead 가 재계산하므로 무해하다.
ALTER TABLE "UserChannelReadState"
    DROP COLUMN "lastReadMessageCreatedAt",
    DROP COLUMN "lastReadMessageId";
