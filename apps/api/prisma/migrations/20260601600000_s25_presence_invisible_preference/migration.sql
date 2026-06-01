-- S25 (FR-P01) — PresencePreference 에 'invisible' 값 추가.
--
-- 사용자가 스스로를 숨길 수 있는 정적 선호값(auto / dnd / invisible). runtime
-- presence status(online/idle/dnd/offline/invisible)는 Redis 가 단일 출처이며,
-- 이 enum 은 connect 시점에 게이트웨이가 읽는 "초기/지속 선호"만 정한다.
--   auto      — 기존 005 의미(연결 시 online, 끊김 시 offline)
--   dnd       — Do Not Disturb(activity/idle 무관 유지)
--   invisible — 본인에게만 보이고 타인에게는 offline 으로 마스킹(maskPresenceForViewer)
--
-- 안전성: ADDITIVE. enum 값 1개 추가일 뿐 기존 row/컬럼/인덱스를 건드리지 않는다
-- (회귀 없음). `ADD VALUE IF NOT EXISTS` 는 멱등이라 재실행/부분실패에 안전하다.
-- DEFAULT 'auto' 와 NOT NULL 제약은 그대로 유지된다(메타데이터만 변경, 테이블
-- 재작성 없음 → NAS 라이브 무중단).
--
-- Reversible: down.sql 동반. enum 값 제거는 PG 에서 직접 불가하므로 enum 을
-- 재생성(rename→create→cast→drop)하며, 그 전에 'invisible' row 를 'auto' 로
-- 되돌린다(선호값은 사용자가 재설정 가능한 파생 설정이라 손실 무해).

ALTER TYPE "PresencePreference" ADD VALUE IF NOT EXISTS 'invisible';
