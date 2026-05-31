-- S03 (ADR-2 / FR-MSG-04 / FR-MSG-05) — message idempotency USER-scope + nonce.
--
-- expand-contract 안전 규칙: 이 슬라이스는 ADDITIVE 만.
--   1. `nonce` 는 nullable 신규 컬럼 → 기존 row 안전 (clientNonce 에코, FR-MSG-04).
--   2. USER-scope partial unique index 신규 추가
--      `(authorId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`
--      (ADR-2 `@@unique([authorId, idempotencyKey])`, channel-independent).
--   3. 기존 channel-scope partial unique index 는 EXPAND 동안 유지한다.
--      (코드 lookup 은 이미 USER-scope 로 전환됐고, 두 인덱스가 공존해도
--       INSERT 정합성은 더 엄격한 USER-scope 쪽이 결정한다. 라이브 클라는
--       채널마다 새 UUID 를 발급하므로 (authorId, key) 충돌 데이터가 없다.)
--      CONTRACT(레거시 인덱스 DROP)는 본 마이그레이션 down 가능성을 위해
--      별도 후속 슬라이스로 미룬다 — 여기선 reversible 을 우선한다.
--
-- 신규 컬럼/인덱스만 추가하므로 lock 비용이 작다(CONCURRENTLY 불필요, 단일 NAS).
-- Reversible: down.sql 동반 (index DROP + 컬럼 DROP).

-- AlterTable (FR-MSG-04): clientNonce 에코 컬럼. nullable → 기존 row 안전.
ALTER TABLE "Message" ADD COLUMN "nonce" UUID;

-- CreateIndex (ADR-2 / FR-MSG-05): USER-scoped 멱등 partial unique index.
-- NULL 키(헤더 미전송)는 인덱스에서 제외 → 무키 전송은 중복 허용(ANSI).
CREATE UNIQUE INDEX "Message_authorId_idempotencyKey_unique"
  ON "Message"("authorId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
