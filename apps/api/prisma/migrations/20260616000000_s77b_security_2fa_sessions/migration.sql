-- S77b (D14 / FR-PS-15·20) — 보안: TOTP 2FA + 세션 관리.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다:
--
--   1. User 에 TOTP 컬럼 2개 ADD:
--      totpSecretEnc(TEXT NULL)            — AES-256-GCM 암호화 시크릿(`iv:tag:ciphertext` base64). null=미설정.
--      totpEnabled(BOOLEAN NOT NULL false) — 2FA 활성 여부. 기존 row 는 false 로 backfill(무회귀).
--   2. RefreshToken 에 lastSeenAt(TIMESTAMP NULL) ADD — 세션 "마지막 활동" 표기 + rotation 갱신.
--      기존 row 는 NULL(활동 기록 없음 → 조회 시 createdAt 폴백).
--   3. BackupCode 신규 테이블 + userId FK(onDelete Cascade) + @@index([userId]).
--      additive 신규 테이블이라 기존 row 영향 없음(backfill 불요).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 트랜잭션
--   블록에서 금지되는 CONCURRENTLY 를 쓰지 않는다(인덱스는 일반 CREATE INDEX).
-- ★ 완전 가역: additive 컬럼 3개 + 신규 테이블 1개라 down.sql 은 테이블 DROP 후 컬럼 DROP 으로
--   무손실 역행한다(s73/s77a "신규 테이블·additive 컬럼 = 완전 가역" 선례). 다운그레이드
--   손실은 2FA/백업코드/lastSeenAt 값에 한정되며 자격증명·세션(RefreshToken 본체)·메시징은 무영향.
-- ★ 멱등 가드(ADD COLUMN 은 IF NOT EXISTS · CREATE TABLE/INDEX 는 IF NOT EXISTS)로 기존 패턴과
--   일관. PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. User TOTP 컬럼 2개 ────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecretEnc" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpEnabled"   BOOLEAN NOT NULL DEFAULT false;

-- ── 2. RefreshToken lastSeenAt ──────────────────────────────────────────────
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);

-- ── 3. BackupCode 신규 테이블 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "BackupCode" (
  "id"        UUID         NOT NULL,
  "userId"    UUID         NOT NULL,
  "codeHash"  TEXT         NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BackupCode_userId_idx" ON "BackupCode"("userId");

-- FK 는 멱등하게(이미 있으면 스킵) 추가한다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BackupCode_userId_fkey'
  ) THEN
    ALTER TABLE "BackupCode"
      ADD CONSTRAINT "BackupCode_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
