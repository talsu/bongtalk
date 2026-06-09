-- AUTH-3 (PRD D18 §5 / FR-AUTH-40~44) — 비밀번호 재설정 토큰 테이블.
--
-- ADDITIVE + reversible. 신규 테이블 1개(PasswordResetToken)만 더한다(기존 row 영향 없음 —
-- backfill 불요). EmailVerificationToken 을 미러링하되 두 가지가 다르다:
--   ① raw 토큰(uuid)을 평문 저장하지 않고 tokenHash(sha256 hex · TEXT)만 저장한다(invite
--      tokenHash 패턴 — DB 유출 시 토큰 역산 방지). @unique 로 O(1) 조회.
--   ② TTL 은 앱 레이어에서 1h(발급+1h)로 둔다(컬럼은 동일 — expiresAt 절대시각만 저장).
-- userId onDelete Cascade(계정 하드삭제 시 토큰 정리). IP rate-limit/이메일 쿨다운은 토큰
-- 행이 아닌 Redis 키로 집행한다(EmailVerification resend 패턴과 일관).
--
-- ★ NO CONCURRENTLY: migrate deploy 가 단일 트랜잭션으로 실행하므로 CONCURRENTLY 금지.
-- ★ 멱등 가드(IF NOT EXISTS)로 s66/s85/s86 패턴과 일관. down.sql 이 테이블을 DROP 한다.
--   PG16 throwaway DB 로 up→down→up 검증.

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"        UUID           NOT NULL,
  "userId"    UUID           NOT NULL,
  "tokenHash" TEXT           NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "usedAt"    TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- tokenHash(sha256) 의 O(1) 조회 + 유일성 보장.
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key"
  ON "PasswordResetToken" ("tokenHash");

-- 사용자별 토큰 정리/조회 보조 인덱스.
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_idx"
  ON "PasswordResetToken" ("userId");

-- userId FK — 계정 하드삭제 시 토큰 행도 함께 정리(ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PasswordResetToken_userId_fkey'
  ) THEN
    ALTER TABLE "PasswordResetToken"
      ADD CONSTRAINT "PasswordResetToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
