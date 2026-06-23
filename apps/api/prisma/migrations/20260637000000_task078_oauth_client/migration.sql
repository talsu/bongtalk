-- task-078 (Family SSO / OIDC IdP) — RP(Relying Party) 레지스트리 테이블.
--
-- ADDITIVE + reversible. 신규 표 1개(OAuthClient)만 더한다(기존 row 영향 없음 — backfill
-- 불요). qufox-api 의 OIDC Provider(panva oidc-provider)가 부팅 시 이 표(enabled=true)를
-- 읽어 client 목록을 구성한다(N번째 패밀리 사이트 = 한 행). client_secret 은 평문이 아니라
-- AES-256-GCM(CryptoService·APP_ENCRYPTION_KEY)으로 암호화한 clientSecretEnc 만 저장한다
-- (oidc-provider 의 client_secret_basic 검증엔 평문이 필요하므로 hash 가 아닌 reversible
-- 암호화; public/PKCE-only client 는 NULL). 휘발성 자산(code/session/grant/token)은 DB 가
-- 아니라 Redis 어댑터(prefix oidc:)에 저장하고, 본 표는 durable 한 RP 메타만 보관한다.
-- redirectUris/metadata 는 JSONB(부팅 시 1회 로드라 쿼리 불요 — text[] 드리프트 회피).
--
-- ★ NO CONCURRENTLY: migrate deploy 가 단일 트랜잭션으로 실행하므로 CONCURRENTLY 금지.
-- ★ 멱등 가드(IF NOT EXISTS)로 기존 패턴과 일관. down.sql 이 테이블을 DROP 한다(PG16
--   throwaway DB 로 up→down→up 검증; 신규 표뿐이라 데이터 손실 없음).

CREATE TABLE IF NOT EXISTS "OAuthClient" (
  "id"              UUID         NOT NULL,
  "clientId"        TEXT         NOT NULL,
  "name"            TEXT         NOT NULL,
  "clientSecretEnc" TEXT,
  "redirectUris"    JSONB        NOT NULL,
  "metadata"        JSONB        NOT NULL DEFAULT '{}',
  "enabled"         BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- client_id 의 O(1) 조회 + 유일성 보장.
CREATE UNIQUE INDEX IF NOT EXISTS "OAuthClient_clientId_key"
  ON "OAuthClient" ("clientId");

-- 부팅 시 enabled=true 만 로드하는 접근 경로 보조 인덱스.
CREATE INDEX IF NOT EXISTS "OAuthClient_enabled_idx"
  ON "OAuthClient" ("enabled");
