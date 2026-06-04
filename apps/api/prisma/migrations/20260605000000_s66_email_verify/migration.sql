-- S66 (D13 / FR-W05a·W05b·W21) — 이메일 인증 + 도메인 게이트.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 다음 변경을 한 트랜잭션(prisma
-- migrate deploy)으로 적용한다:
--
--   1. User 에 emailVerified BOOLEAN NOT NULL DEFAULT false 추가.
--      기존 row 는 default false 로 backfill 된다(인증 게이트만 추가 — 무회귀).
--      seed 사용자(seed.ts)만 emailVerified=true 로 시드해 dev 차단을 피한다.
--   2. EmailVerificationToken 테이블 신규(uuid PK · userId FK ON DELETE CASCADE ·
--      token uuid UNIQUE · expiresAt · usedAt? · createdAt). 인덱스: token UNIQUE,
--      userId.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 migration.sql 을 단일 트랜잭션으로
--   실행하므로 CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 완전 가역: additive 신규 컬럼 + 신규 테이블이라 down.sql 은 테이블 DROP + 컬럼
--   DROP 으로 무손실 역행한다(enum 추가 없음 — S65 와 동일하게 대칭적이다).
-- ★ 멱등 가드(IF NOT EXISTS)로 s51/s53/s54/s55/s60/s61/s65 패턴과 일관한다.
--   PG16 throwaway DB 로 up→down→up 검증.

-- ── 1. User.emailVerified 컬럼 추가 ─────────────────────────────────────────
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. EmailVerificationToken 테이블 신규 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailVerificationToken" (
  "id"        UUID         NOT NULL,
  "userId"    UUID         NOT NULL,
  "token"     UUID         NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "usedAt"    TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- token 추측 불가 uuid 의 O(1) 조회 + 유일성 보장.
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationToken_token_key"
  ON "EmailVerificationToken" ("token");

-- 사용자별 토큰 정리/조회 보조 인덱스.
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_userId_idx"
  ON "EmailVerificationToken" ("userId");

-- userId FK — 계정 하드삭제 시 토큰 행도 함께 정리(ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EmailVerificationToken_userId_fkey'
  ) THEN
    ALTER TABLE "EmailVerificationToken"
      ADD CONSTRAINT "EmailVerificationToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
