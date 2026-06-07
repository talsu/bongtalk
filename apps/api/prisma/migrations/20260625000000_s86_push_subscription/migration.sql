-- S86 (D16 / FR-MN-15) — Web Push(VAPID) 구독 테이블.
--
-- ADDITIVE + reversible. 신규 테이블 1개(PushSubscription)를 더한다(기존 row 영향 없음 —
-- backfill 불요). 사용자 1명이 기기/브라우저별 다수 구독을 보유하며, push service 가 발급한
-- endpoint URL 이 전역 고유라 UNIQUE 로 둔다(같은 endpoint 재구독은 앱 레이어 upsert 가 흡수).
-- userId onDelete Cascade(계정 삭제 시 구독 정리). 410/404 stale endpoint 는 PushService 가 GC.
--
-- 전 DDL 을 멱등으로 감싼다(s85 IF NOT EXISTS 패턴 일관): 테이블 CREATE TABLE IF NOT EXISTS,
-- 인덱스 CREATE [UNIQUE] INDEX IF NOT EXISTS, FK 는 제약 존재검사(DO $$ … pg_constraint).
-- NO CONCURRENTLY(트랜잭션 마이그레이션 정합). down.sql 이 테이블을 DROP 한다.
-- PG16 throwaway DB 로 up→down→up 검증.

CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"         UUID NOT NULL,
  "userId"     UUID NOT NULL,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "ua"         TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key"
  ON "PushSubscription" ("endpoint");

CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx"
  ON "PushSubscription" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_userId_fkey'
  ) THEN
    ALTER TABLE "PushSubscription"
      ADD CONSTRAINT "PushSubscription_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
