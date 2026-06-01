-- S24 (FR-RS-18) — mark-all-read 내구 스냅샷 테이블.
--
-- read-all 실행 순서: (1) 현재 ChannelReadState SELECT → snapshot, (2) Redis(TTL
-- 5분) + DB(이 테이블) 이중 저장(2단계 실패 시 ACK 미진행 + 500), (3) set-based
-- ACK UPDATE. Undo 엔드포인트가 Redis 히트 시 Redis, miss 시 이 테이블로 채널별
-- lastReadMessageId 를 되돌린다(후진 허용 — markUnread 와 동일 비-monotonic 경로).
--
-- ADDITIVE: 신규 테이블 + 인덱스 2개만 생성하므로 기존 row/컬럼/인덱스를 전혀
-- 건드리지 않는다(회귀 없음). snapshot 은 채널별 직전 커서 맵을 담는 JSONB.
-- Reversible: down.sql 이 대칭 DROP. throwaway PG16 에서 up→down→up 검증.

CREATE TABLE "MarkAllReadSnapshot" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "userId"      UUID         NOT NULL,
    "workspaceId" UUID         NOT NULL,
    "snapshot"    JSONB        NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "MarkAllReadSnapshot_pkey" PRIMARY KEY ("id")
);

-- Undo lookup 은 snapshotId(PK)로 직접 조회하지만, (userId, workspaceId) 인덱스는
-- 향후 워크스페이스 단위 최신 스냅샷 조회 / 정리 쿼리에 쓴다.
CREATE INDEX "MarkAllReadSnapshot_userId_workspaceId_idx"
    ON "MarkAllReadSnapshot" ("userId", "workspaceId");

-- expiresAt 정리(cron/query-time GC)는 DEFER(carryover)지만 인덱스는 선제 존재.
CREATE INDEX "MarkAllReadSnapshot_expiresAt_idx"
    ON "MarkAllReadSnapshot" ("expiresAt");
