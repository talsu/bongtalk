-- S73 (D14 / FR-PS-01·02·03) — 전역 프로필 신원 레이어 + 아바타.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 다음 변경을 한 트랜잭션(prisma
-- migrate deploy)으로 적용한다:
--
--   1. User 에 nullable additive 컬럼 7개 추가:
--      handle(UNIQUE) · displayName · fullName(50) · pronouns(40) · title(80) ·
--      avatarKey · handleChangedAt(TIMESTAMPTZ). 전부 nullable 라 기존 row 안전
--      (default 불요 — 인증/메시징과 무관한 표시 신원 필드).
--   2. handle 백필: 기존 username 을 소문자화 + 허용문자([a-z0-9_.]) 외 제거 후,
--      그 결과가 (a) 3–32자 형식을 만족하고 (b) 다른 사용자가 점유하지 않은
--      경우에만 복사한다(Option B — username 컬럼은 하위호환 유지). 형식 위반/충돌은
--      NULL 로 남겨 API 가 `handle ?? username` 으로 폴백한다(무손실·무회귀).
--   3. handle 명시 인덱스(@@index) — @unique 가 이미 btree 를 만들지만 PLAN 명세대로
--      IF NOT EXISTS 가드로 추가한다(중복 시 no-op).
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로
--   CREATE INDEX CONCURRENTLY(트랜잭션 블록 금지)는 쓰지 않는다.
-- ★ 완전 가역: additive 신규 컬럼 + 백필이라 down.sql 은 컬럼 DROP 으로 무손실 역행한다
--   (백필된 handle 은 컬럼과 함께 사라짐 — 기존 username/email 은 무영향). enum 추가 없음.
-- ★ 멱등 가드(IF NOT EXISTS)로 s51/s54/s60/s61/s65/s66 패턴과 일관. PG16 throwaway DB
--   로 up→down→up 검증.

-- ── 1. User 전역 프로필 컬럼 추가 ────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "handle"          TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "displayName"     TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "fullName"        VARCHAR(50);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pronouns"        VARCHAR(40);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "title"           VARCHAR(80);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarKey"       TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "handleChangedAt" TIMESTAMPTZ(6);

-- ── 2. handle 백필: username → 소문자 + 허용문자만 + (형식 OK & 미점유)일 때 복사 ──
-- regexp_replace 로 [a-z0-9_.] 외 문자를 제거(소문자화 후). 결과 길이 3–32 이고,
-- 다른 row 가 같은 후보를 점유하지 않은 경우에만 설정한다(NOT EXISTS 자기참조 가드 —
-- 두 username 이 같은 후보로 정규화되면 둘 다 NULL 로 남아 충돌을 회피한다).
WITH candidate AS (
  SELECT
    "id",
    regexp_replace(lower("username"), '[^a-z0-9_.]', '', 'g') AS h
  FROM "User"
)
UPDATE "User" u
SET "handle" = c.h
FROM candidate c
WHERE u."id" = c."id"
  AND length(c.h) BETWEEN 3 AND 32
  AND NOT EXISTS (
    SELECT 1 FROM candidate c2
    WHERE c2.h = c.h AND c2."id" <> c."id"
  );

-- ── 3. handle UNIQUE 제약 + 명시 인덱스 ─────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "User_handle_key" ON "User" ("handle");
-- PLAN 명세 @@index([handle]) — @unique 인덱스와 별개로 명시(중복 시 no-op).
CREATE INDEX IF NOT EXISTS "User_handle_idx" ON "User" ("handle");
