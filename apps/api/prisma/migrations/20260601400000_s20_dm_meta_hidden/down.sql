-- S20 rollback — 대칭 역순 DROP. 모든 신규 객체는 ADDITIVE nullable 이었으므로
-- 손실 무해: displayName/iconUrl 은 DM 메타 재설정으로 복구 가능, hiddenAt 은
-- 숨김 상태(다시 숨기면 복구)다. throwaway PG16 에서 up→down→up 검증.

-- (3) ChannelPermissionOverride.hiddenAt DROP.
ALTER TABLE "ChannelPermissionOverride"
    DROP COLUMN IF EXISTS "hiddenAt";

-- (2) Channel.iconUrl DROP.
ALTER TABLE "Channel"
    DROP COLUMN IF EXISTS "iconUrl";

-- (1) Channel.displayName DROP.
ALTER TABLE "Channel"
    DROP COLUMN IF EXISTS "displayName";
