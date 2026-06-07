-- S88b (ADR B3 / FR-MN-19 · FR-MN-03): MentionRecord 멘션 전달 로그 + 멱등 게이트.
--
-- mention-broadcast BullMQ 워커가 `@<RoleName>` 멘션을 역할 멤버로 expand 한 뒤,
-- VIEW_CHANNEL 가시 멤버마다 1행을 멱등 INSERT 한다(UNIQUE(messageId, targetId,
-- targetType) + ON CONFLICT DO NOTHING). 신규 삽입된 행에 한해서만 워커가
-- mention.received outbox 를 1건 기록하므로(retry/재시작 재처리에도 1행·outbox 중복 0),
-- 이 테이블이 멱등 보장의 단일 출처다.
--
-- ADDITIVE · NO CONCURRENTLY(트랜잭션 마이그레이션 정합 · auto-deploy.sh psql -f 호환) ·
-- reversible. 전 DDL 을 멱등으로 감싼다(s85/s86 IF NOT EXISTS / pg_constraint 패턴 일관) —
-- enum 은 DO $$ pg_type 가드, 테이블/인덱스는 IF NOT EXISTS, FK 는 pg_constraint 존재검사.
--
-- down migration (수동 롤백):
--   DROP TABLE IF EXISTS "MentionRecord";
--   DROP TYPE IF EXISTS "MentionTargetType";
-- (additive 신규 테이블/타입이라 데이터 손실 없이 완전히 되돌아간다.)
-- PG16 throwaway DB 로 up→down→up 검증.

-- 멘션 대상 유형. USER 만 사용한다(@role 은 워커가 멤버로 expand 해 USER 로 기록).
-- ROLE 은 향후 역할 자체 보관용 예약값(현재 미사용).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MentionTargetType') THEN
    CREATE TYPE "MentionTargetType" AS ENUM ('USER', 'ROLE');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "MentionRecord" (
  "id"          UUID NOT NULL,
  "messageId"   UUID NOT NULL,
  "targetId"    UUID NOT NULL,
  "targetType"  "MentionTargetType" NOT NULL,
  "channelId"   UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MentionRecord_pkey" PRIMARY KEY ("id")
);

-- 멱등 게이트: 동일 (메시지, 대상, 대상유형) 조합은 정확히 1행.
CREATE UNIQUE INDEX IF NOT EXISTS "MentionRecord_messageId_targetId_targetType_key"
  ON "MentionRecord" ("messageId", "targetId", "targetType");

-- 사용자별 멘션 타임라인 조회(후속 읽기 경로 전환용) 커버 인덱스.
CREATE INDEX IF NOT EXISTS "MentionRecord_targetId_createdAt_idx"
  ON "MentionRecord" ("targetId", "createdAt");

-- FK: 메시지/워크스페이스 hard-delete 시 전달 로그도 함께 정리(CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MentionRecord_messageId_fkey'
  ) THEN
    ALTER TABLE "MentionRecord"
      ADD CONSTRAINT "MentionRecord_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "Message"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MentionRecord_workspaceId_fkey'
  ) THEN
    ALTER TABLE "MentionRecord"
      ADD CONSTRAINT "MentionRecord_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
