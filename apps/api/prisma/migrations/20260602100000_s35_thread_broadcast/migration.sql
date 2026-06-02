-- S35 (D04 스레드 broadcast) — FR-TH-06 / FR-TH-14 isBroadcast 플래그.
--
-- Message 에 컬럼 하나를 추가한다:
--   isBroadcast  BOOLEAN NOT NULL DEFAULT false
--
-- PRD 데이터 모델(Message 발췌, FR-TH-06/14)이 `isBroadcast Boolean @default(false)`
-- 를 단일 권위로 명시한다. 스레드 답글을 'Also send to #channel' 체크와 함께
-- 전송하면(FR-TH-06), send tx 안에서 별도의 SYSTEM_THREAD_BROADCAST 행을 채널
-- 타임라인에 동시 게시하고 그 행에 isBroadcast=true 를 박는다. 이 플래그는:
--   1) 채널 타임라인 가시성 — rawList 의 roots-only 필터(parentMessageId IS NULL)
--      에 `OR isBroadcast` 예외를 더해 broadcast 행(parentMessageId = thread root)을
--      채널에 노출한다.
--   2) FR-TH-14 채널 미읽 — broadcast 행만 채널 unread 에 포함(S36 의존).
--   3) FR-TH-14 삭제 — broadcast 행 soft-delete 시 채널 unreadCount 1 감소(S36).
--
-- additive + reversible: NOT NULL DEFAULT false 라 기존 행이 전부 false 로
-- 안전하게 백필되며 backfill 쿼리가 필요 없다. down.sql 이 컬럼을 DROP 한다.

-- 컬럼 추가 (IF NOT EXISTS — 재실행 안전)
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "isBroadcast" BOOLEAN NOT NULL DEFAULT false;

-- S35 fix-forward (perf CRITICAL): broadcast 행용 partial index.
--
-- rawList(채널 타임라인)의 roots-only 필터가 broadcast 예외로
-- `("parentMessageId" IS NULL OR "isBroadcast" = true)` 가 되면서, 기존
-- roots-only partial index(`Message_channel_roots_idx ... WHERE "parentMessageId"
-- IS NULL`)만으로는 broadcast 행(parentMessageId NOT NULL)을 커버하지 못해 OR 의
-- broadcast 가지가 인덱스를 무력화(seq scan 폴백)했다. broadcast 행 전용 partial
-- index 를 추가해, 플래너가 두 partial index 를 BitmapOr 로 합성하도록 한다:
--   roots 가지  → Message_channel_roots_idx     (WHERE parentMessageId IS NULL)
--   bcast 가지  → Message_channel_broadcast_idx  (WHERE isBroadcast = true)
-- 채널 타임라인은 broadcast 행이 극소수(sparse)라 partial index 가 작고
-- 선택적이다. createdAt DESC 정렬은 roots index 와 동일 정렬키를 써 머지 비용을
-- 낮춘다. down.sql 이 DROP 한다(reversible).
--
-- 운영 주의(task-014-B precedent): prod 의 populated 테이블에는 AccessExclusive
-- 락을 피하려 CREATE INDEX CONCURRENTLY 가 필요하나, Prisma migration 의 암묵적
-- 트랜잭션 안에서는 CONCURRENTLY 가 불가하다. dev/test/fresh migrate 는 plain
-- CREATE INDEX 로 충분하다(이 슬라이스는 prod 미적용 — 게이트에서 PG16 up→down→up
-- 으로 재검증).
CREATE INDEX IF NOT EXISTS "Message_channel_broadcast_idx"
  ON "Message"("channelId", "createdAt" DESC)
  WHERE "isBroadcast" = true;
