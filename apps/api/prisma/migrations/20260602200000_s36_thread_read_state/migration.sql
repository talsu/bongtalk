-- S36 (D04·D09 / FR-RS-12 / FR-TH-04/11/12/18) — 스레드 단위 읽음 커서.
--
-- ThreadReadState 신규 테이블을 추가한다. 채널 미읽(UserChannelReadState)과
-- 독립적으로 스레드 미읽을 추적하며, 채널 미읽과 동일한 (createdAt, id) 튜플
-- 커서 패턴(S11)을 그대로 따른다:
--
--   thread-unread ⇔ COUNT(*) FROM "Message"
--      WHERE "parentMessageId" = :rootId
--        AND "isBroadcast" = false        -- broadcast 행은 채널 미읽에만 산입
--        AND "deletedAt" IS NULL
--        AND ("createdAt","id") > (:lastReadAt, :lastReadMessageId)
--
-- 설계(S36 — 옵션 B "unread = 계산"):
--   - **튜플 커서만** 저장한다(lastReadMessageId + lastReadMessageCreatedAt).
--     denormalized unreadCount 컬럼은 두지 않는다 — 미읽 수는 조회 시 SQL COUNT
--     로 계산해 drift 를 원천 차단한다(S11 채널-unread 정합). denormalized
--     unreadCount 컬럼 + Threads 탭(FR-TH-09/10)은 S38 carryover.
--   - uuid PK + 튜플-커서-only: 본 프로젝트의 Message / UserChannelReadState 가
--     모두 uuid PK + 튜플 커서라 코드 정합을 위해 동일 패턴으로 둔다(PRD 카드의
--     cuid2 PK + unreadCount 컬럼 표기는 ADR-2 이전 표기 — 실제 스키마와 다름).
--
-- 키:
--   - (userId, parentMessageId) UNIQUE — monotonic upsert 충돌 타깃.
--   - (parentMessageId) INDEX — 루트 hard delete 시 Cascade + per-root 조회.
--   - (userId, updatedAt DESC) INDEX — Threads 탭(S38) "내 스레드 최근순".
--
-- onDelete CASCADE 2종:
--   - userId → User: 사용자 삭제 시 그 사용자의 커서 정리.
--   - parentMessageId → Message: 루트 hard delete(운영 purge) 시 고아 커서
--     방지(PRD FR-TH 엣지케이스 — purge 시 ThreadSubscription/ThreadReadState
--     함께 삭제).
--
-- additive + reversible: 신규 테이블이라 기존 row 영향 0, backfill 불필요.
-- down.sql 이 DROP TABLE 한다(reversible). PG16 up→down→up 으로 게이트 재검증.

CREATE TABLE "ThreadReadState" (
  "id"                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"                    UUID         NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "parentMessageId"           UUID         NOT NULL REFERENCES "Message" ("id") ON DELETE CASCADE,
  "lastReadMessageId"         UUID,
  "lastReadMessageCreatedAt"  TIMESTAMPTZ,
  "updatedAt"                 TIMESTAMP(3) NOT NULL
);

-- monotonic upsert 충돌 타깃: 사용자당 스레드 1행.
CREATE UNIQUE INDEX "ThreadReadState_userId_parentMessageId_key"
  ON "ThreadReadState" ("userId", "parentMessageId");

-- 루트 단위 조회 + Cascade 보조.
CREATE INDEX "ThreadReadState_parentMessageId_idx"
  ON "ThreadReadState" ("parentMessageId");

-- Threads 탭(S38) "내 스레드 최근순" 조회용 — userId 스코프 updatedAt DESC.
CREATE INDEX "ThreadReadState_userId_updatedAt_idx"
  ON "ThreadReadState" ("userId", "updatedAt" DESC);
