-- S05 (FR-MSG-06 / FR-RC16) — MessageEditHistory 테이블.
--
-- expand-contract 안전 규칙: ADDITIVE 만. 신규 테이블 1개 + FK 1개 + index
-- 1개만 추가하므로 기존 row / 기존 컬럼은 전혀 건드리지 않는다(회귀 없음).
-- 편집(PATCH) 시 직전 본문 스냅샷을 한 행으로 적재하고, 메시지별 ring buffer
-- cap(10)은 서비스 레이어에서 enforce 한다(DB 제약 아님 — 운영 유연성).
--
-- `version` 은 스냅샷 당시(편집 전) 메시지 version. `editedAt` 은 해당 편집
-- 발생 시각(timestamptz). messageId FK 는 ON DELETE CASCADE — 메시지 hard
-- delete(purge worker) 시 이력도 함께 정리된다(soft delete 는 영향 없음).
--
-- seed 결정성 무관(신규 테이블, 시드가 채우지 않음).
-- Reversible: down.sql 동반(테이블 DROP).

-- CreateTable
CREATE TABLE "MessageEditHistory" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "contentRaw" TEXT,
    "contentAst" JSONB,
    "contentPlain" TEXT NOT NULL,
    "editedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEditHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (ring buffer 정렬 + (messageId, version) 조회 경로)
CREATE INDEX "MessageEditHistory_messageId_version_idx"
    ON "MessageEditHistory"("messageId", "version");

-- AddForeignKey (ON DELETE CASCADE — 메시지 hard delete 시 이력 정리)
ALTER TABLE "MessageEditHistory"
    ADD CONSTRAINT "MessageEditHistory_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
