-- S17 rollback — additive 컬럼 1개 DROP. visibleFrom 은 DM 개설/복원 시점에
-- 재세팅 가능한 파생 가시성 하한선이라 손실되어도 다음 createOrGet 재진입이
-- 재계산하므로 무해하다.
ALTER TABLE "ChannelPermissionOverride"
    DROP COLUMN "visibleFrom";
