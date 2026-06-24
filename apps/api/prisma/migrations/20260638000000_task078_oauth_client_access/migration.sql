-- task-078 P2-acl — RP 접근 허용목록(인가). 신규 표 1개(OAuthClientAccess).
--
-- ADDITIVE + reversible. 인증(qufox 로그인)과 별개로 "이 user 가 이 client 에 승인됐는가"를
-- IdP 가 중앙 강제한다. 행 1개 = 승인 1건. clientId 는 OAuthClient.clientId 와 동일 문자열.
-- userId FK 는 계정 하드삭제 시 cascade(수동 DO 블록 — PasswordResetToken 패턴, User 모델 무수정).
-- (clientId, userId) 유일 제약으로 중복 승인 방지 + O(1) 조회.
--
-- ★ NO CONCURRENTLY (migrate deploy 단일 트랜잭션). 멱등 가드. down.sql 이 DROP.

CREATE TABLE IF NOT EXISTS "OAuthClientAccess" (
  "id"        UUID         NOT NULL,
  "clientId"  TEXT         NOT NULL,
  "userId"    UUID         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" UUID,

  CONSTRAINT "OAuthClientAccess_pkey" PRIMARY KEY ("id")
);

-- (clientId, userId) 유일 — 중복 승인 방지 + composite 조회 키.
CREATE UNIQUE INDEX IF NOT EXISTS "OAuthClientAccess_clientId_userId_key"
  ON "OAuthClientAccess" ("clientId", "userId");

-- client 별 승인자 목록 / user 별 접근 client 조회 보조 인덱스.
CREATE INDEX IF NOT EXISTS "OAuthClientAccess_clientId_idx"
  ON "OAuthClientAccess" ("clientId");
CREATE INDEX IF NOT EXISTS "OAuthClientAccess_userId_idx"
  ON "OAuthClientAccess" ("userId");

-- userId FK — 계정 하드삭제 시 승인 행도 함께 정리(ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OAuthClientAccess_userId_fkey'
  ) THEN
    ALTER TABLE "OAuthClientAccess"
      ADD CONSTRAINT "OAuthClientAccess_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
