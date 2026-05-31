-- S17 (FR-DM-17 / FR-TH-19) — DM 가시성 하한선(visibleFrom) 컬럼 추가.
--
-- expand-contract 안전 규칙: ADDITIVE 만. ChannelPermissionOverride 에 nullable
-- 컬럼 1개만 추가하므로 기존 row / 기존 컬럼 / 기존 인덱스는 전혀 건드리지 않는다
-- (회귀 없음). 비-DIRECT 채널·ROLE override·legacy DM row 는 NULL 로 back-fill
-- 되며, NULL 은 "전체 히스토리 가시" 로 해석되어 메시지 list 필터가 무영향이다.
--
-- 설계 근거(visibleFrom 위치): DM 멤버십은 별도 모델 없이 ChannelPermissionOverride
-- 의 USER-principal row 로 표현된다(S16). 이 row 는 ① DM 개설 트랜잭션에서 참여자
-- 1인당 정확히 1개 생성되어 "개설 시점"에 visibleFrom 을 박을 자리가 보장되고,
-- ② per-(user, channel) 카디널리티가 DM 가시성 의미와 정확히 일치하며, ③ 메시지
-- list 쿼리가 이미 요청자의 USER override(allowMask & READ)로 멤버십을 판정하므로
-- 같은 row 의 visibleFrom 을 JOIN 한 줄로 끌어올 수 있다. UserChannelReadState 는
-- 읽기 시점 lazy upsert 라 개설 시점 row 존재 보장이 없어 부적합했다. ROLE override
-- 와의 혼재 우려는 visibleFrom 을 DM 의 USER row 에만 세팅하고 필터가 요청자
-- USER override 만 조회하므로 발생하지 않는다.
--
-- Reversible: down.sql 동반(컬럼 DROP — 가시성 하한선은 DM 개설/복원 시 재세팅
-- 가능한 파생값이라 손실 무해).

-- AlterTable
ALTER TABLE "ChannelPermissionOverride"
    ADD COLUMN "visibleFrom" TIMESTAMPTZ;
