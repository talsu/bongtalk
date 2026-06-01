-- S19 rollback — 대칭 역순. 모든 신규 객체는 ADDITIVE 였으므로 손실 무해:
-- joinedAt/owner 는 DM 개설/추가 시점에 재계산 가능한 파생값, leftAt 은 항상
-- NULL 시작, allowDmFrom 은 DEFAULT 복원 가능. throwaway PG16 에서 up→down→up 검증.

-- (7) 부분 인덱스 DROP.
DROP INDEX IF EXISTS "CPO_dm_active_members_idx";

-- (4) ChannelPermissionOverride 컬럼 DROP (leftAt → joinedAt).
ALTER TABLE "ChannelPermissionOverride"
    DROP COLUMN IF EXISTS "leftAt",
    DROP COLUMN IF EXISTS "joinedAt";

-- (3) Channel.ownerId FK + 컬럼 DROP.
ALTER TABLE "Channel"
    DROP CONSTRAINT IF EXISTS "Channel_ownerId_fkey";
ALTER TABLE "Channel"
    DROP COLUMN IF EXISTS "ownerId";

-- (2) User.allowDmFrom DROP.
ALTER TABLE "User"
    DROP COLUMN IF EXISTS "allowDmFrom";

-- (1) enum DROP.
DROP TYPE IF EXISTS "DmPrivacy";
