-- S20 (FR-DM-04/05/06/10) — DM 표시 메타(이름/아이콘) + per-user DM 숨김.
--
-- expand-contract 안전 규칙: ADDITIVE 만. 신규 nullable 컬럼 3개만 추가하므로
-- 기존 row / 기존 컬럼 / 기존 인덱스를 전혀 건드리지 않는다(회귀 없음). 세 컬럼
-- 모두 nullable 이라 기존 row 는 NULL 로 시작한다:
--   - Channel.displayName NULL = 사용자 지정 이름 미설정(slug `name` 으로 폴백 표시).
--   - Channel.iconUrl     NULL = 기본 아바타.
--   - ChannelPermissionOverride.hiddenAt NULL = DM 목록에 표시(숨김 아님).
--
-- 설계 메모:
--   - Channel.name 은 1:1(`dm:%`)·그룹(`gdm:%`) DM 의 dedup slug 라 불변이다.
--     사용자가 보는 표시명은 별도 컬럼 displayName 에 둔다(group DM 전용 — 1:1·
--     미설정은 NULL). list/listGroups 가 displayName ?? name 으로 렌더.
--   - hiddenAt 은 S17 visibleFrom / S19 joinedAt·leftAt 과 같은
--     ChannelPermissionOverride USER 멤버십 row 에 동거하는 per-(user,channel)
--     상태다. soft-leave(allowMask=0 + leftAt)와 독립적인 축이다 — 멤버십은
--     유지하되 사이드바 목록에서만 가린다. 상대방의 새 메시지 도착 시 서비스가
--     수신자(보낸 본인 제외)의 hiddenAt 을 NULL 로 자동 복원한다(FR-DM-10).
--     visibleFrom 은 재설정하지 않으므로 과거 메시지는 그대로 보인다(숨김만 해제).
--
-- Reversible: down.sql 동반(대칭 역순 DROP). 세 컬럼 모두 nullable 파생/상태값이라
-- 손실 무해. throwaway PG16 에서 up→down→up 검증.

-- (1) Channel.displayName — group DM 사용자 지정 표시명. 1:1·미설정 NULL.
ALTER TABLE "Channel"
    ADD COLUMN "displayName" TEXT;

-- (2) Channel.iconUrl — group DM 아이콘 MinIO 키/URL. 미설정 NULL.
ALTER TABLE "Channel"
    ADD COLUMN "iconUrl" TEXT;

-- (3) ChannelPermissionOverride.hiddenAt — per-user DM 숨김 시각. NULL = 표시.
ALTER TABLE "ChannelPermissionOverride"
    ADD COLUMN "hiddenAt" TIMESTAMPTZ;
