-- FR-RM10b (069 / ADR E1·E2 확장): AutoMod 정규식 KEYWORD + MENTION_SPAM / REPEAT_SPAM.
--
-- 1) AutoModMatch enum 에 REGEX 추가 — KEYWORD 룰의 keywords[] 를 정규식 패턴으로 해석한다
--    (SUBSTRING/WORD 리터럴은 종전대로). 정규식 매칭은 worker_threads 격리(ReDoS 회피).
-- 2) AutoModRule 에 spam 트리거 컬럼 추가(전부 nullable · KEYWORD 룰은 null):
--      mentionThreshold — MENTION_SPAM: 윈도 내 누적 멘션 수 임계값.
--      repeatThreshold  — REPEAT_SPAM:  윈도 내 동일 본문 반복 횟수 임계값.
--      windowSeconds    — 두 spam 트리거의 sliding window 길이(초).
--
-- ADDITIVE · NO CONCURRENTLY(트랜잭션 마이그레이션 정합 · auto-deploy.sh psql -f 호환) ·
-- forward-safe · reversible. 전 DDL 을 멱등으로 감싼다(IF NOT EXISTS / ADD VALUE IF NOT
-- EXISTS — 029 / s85 / s86 패턴 일관).
--
-- ★ALTER TYPE ... ADD VALUE 주의: PG 에서 ADD VALUE 는 같은 트랜잭션 안에서 그 값을 즉시
--   사용할 수 없다. 본 마이그레이션은 enum 값을 어디에도 쓰지 않고(컬럼 추가만) 단지 enum
--   도메인만 확장하므로 안전하다(IF NOT EXISTS 로 재실행 멱등).
--
-- down migration (수동 롤백):
--   -- spam 컬럼은 nullable·additive 라 데이터 손실 없이 제거 가능:
--   ALTER TABLE "AutoModRule" DROP COLUMN IF EXISTS "windowSeconds";
--   ALTER TABLE "AutoModRule" DROP COLUMN IF EXISTS "repeatThreshold";
--   ALTER TABLE "AutoModRule" DROP COLUMN IF EXISTS "mentionThreshold";
--   -- enum 값 제거는 PG 가 ALTER TYPE ... DROP VALUE 를 지원하지 않으므로 타입 재생성이
--   -- 필요하다(REGEX 를 쓰는 룰이 없을 때만). 실무 롤백에선 REGEX 값을 잔존시켜도 무해하다
--   -- (미사용 enum 멤버). 완전 제거가 필요하면 새 타입 생성→컬럼 캐스트→old drop 절차로:
--   --   CREATE TYPE "AutoModMatch_old" AS ENUM ('SUBSTRING', 'WORD');
--   --   ALTER TABLE "AutoModRule" ALTER COLUMN "matchMode" TYPE "AutoModMatch_old"
--   --     USING ("matchMode"::text::"AutoModMatch_old");
--   --   DROP TYPE "AutoModMatch"; ALTER TYPE "AutoModMatch_old" RENAME TO "AutoModMatch";
-- PG16 throwaway DB 로 up→down→up 검증.

-- (1) AutoModMatch 에 REGEX 추가(멱등 — 이미 있으면 no-op).
ALTER TYPE "AutoModMatch" ADD VALUE IF NOT EXISTS 'REGEX';

-- (2) spam 트리거 컬럼(전부 nullable · KEYWORD 룰은 null).
ALTER TABLE "AutoModRule" ADD COLUMN IF NOT EXISTS "mentionThreshold" INTEGER;
ALTER TABLE "AutoModRule" ADD COLUMN IF NOT EXISTS "repeatThreshold" INTEGER;
ALTER TABLE "AutoModRule" ADD COLUMN IF NOT EXISTS "windowSeconds" INTEGER;
