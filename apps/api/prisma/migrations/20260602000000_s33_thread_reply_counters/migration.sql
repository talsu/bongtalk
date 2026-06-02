-- S33 (D04 스레드 코어) — FR-TH-16 / FR-TH-17 비정규화 카운터.
--
-- 두 컬럼을 Message 에 추가한다(루트 메시지에만 의미):
--   1) replyCount    INTEGER NOT NULL DEFAULT 0 — 비삭제 답글 수.
--   2) latestReplyAt  TIMESTAMPTZ NULL          — 마지막 답글 createdAt.
--
-- FR-TH-16 은 채널 메시지 목록의 threadMeta(replyCount/latestReplyAt)를 별도
-- 집계 쿼리 없이 컬럼 직접 반환으로 해석하라고 명시한다. 이 두 컬럼이 그
-- 비정규화 read-path 캐시다. 답글 send/soft-delete 의 단일 $transaction 안에서
-- 원자적으로 갱신한다(FR-TH-17 기초).
--
-- additive + reversible: 두 컬럼 모두 NOT NULL DEFAULT / NULL 이라 기존 행이
-- 안전하다. 아래 backfill 이 기존 루트 행의 카운터를 실제 비삭제 답글로부터
-- 한 번 재계산한다(드물게 존재하는 task-014-B 시절 스레드 데이터 정합).
-- down.sql 이 두 컬럼을 DROP 한다.

-- 1) 컬럼 추가 (IF NOT EXISTS — 재실행 안전)
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "replyCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "latestReplyAt" TIMESTAMPTZ;

-- 2) backfill — 기존 루트 행(parentMessageId IS NULL)의 카운터를 비삭제
--    답글로부터 재계산한다. 답글이 없는 루트는 서브쿼리가 0/NULL 을 돌려
--    DEFAULT 와 동일하므로 영향이 없다. 답글 행 자체는 갱신하지 않는다
--    (replyCount=0/latestReplyAt=NULL 유지 — 답글은 스레드를 호스트하지 않음).
-- S33 fix-forward (db-migrator LOW): backfill 의 timezone 독립성 명시.
--   latestReplyAt 컬럼은 timestamptz 이지만, Message.createdAt 은 `DateTime`
--   (Timestamptz 미지정)이라 Postgres 에서 naive `timestamp`(시간대 없음) 로
--   매핑된다. 따라서 naive `MAX(r."createdAt")` 를 timestamptz 컬럼에 그대로
--   대입하면 Postgres 가 *세션 TimeZone* 으로 naive→aware 암묵 캐스트를 수행해
--   세션 TZ 에 따라 적재값이 달라진다. prod 는 UTC 라 현재 정상이나, 방어적으로
--   `AT TIME ZONE 'UTC'` 로 naive wall-clock 을 명시적으로 UTC 로 해석해 세션
--   TZ 와 무관하게 결정적인 값을 적재한다(naive timestamp 에 대해 AT TIME ZONE
--   'UTC' 는 그 wall-clock 을 UTC instant 로 보는 timestamptz 를 만든다).
UPDATE "Message" AS root
   SET "replyCount" = sub.cnt,
       "latestReplyAt" = sub.last_at
  FROM (
    SELECT r."parentMessageId"                     AS pid,
           COUNT(*)::int                           AS cnt,
           MAX(r."createdAt") AT TIME ZONE 'UTC'    AS last_at
      FROM "Message" r
     WHERE r."parentMessageId" IS NOT NULL
       AND r."deletedAt" IS NULL
     GROUP BY r."parentMessageId"
  ) AS sub
 WHERE root.id = sub.pid;
