-- S29 (FR-S05 / ADR-2) — 검색 수식어 `has:link|image|file` 용 비정규화 boolean 컬럼.
--
-- 동기: 검색 SQL 에서 has: 필터를 매 요청 Attachment EXISTS 서브쿼리 + 본문 URL
-- 정규식으로 평가하면 GIN 경로와 합쳐질 때 플래너가 불리해진다. Discord-parity 의
-- has: 필터는 send/edit 시점에 한 번 계산해 메시지 행에 박아두는 비정규화가
-- 정석이다(ADR-2 read-path 분리). `is:pinned` 은 별도 컬럼을 추가하지 않고 기존
-- `pinnedAt IS NOT NULL` 을 그대로 쓴다 — pin/unpin 경로가 advisory-lock 아래
-- pinnedAt 을 원자적으로 유지하므로 중복 컬럼은 동기화 부채만 늘린다.
--
-- expand-contract 안전: ADDITIVE 만. 3개 컬럼 모두 NOT NULL DEFAULT false 로
-- 추가하므로 기존 row 는 즉시 false 로 채워지고(잠금 짧음 — PG16 은 DEFAULT 상수
-- 추가 시 테이블 rewrite 없음), 이어지는 backfill UPDATE 가 실제 값을 채운다.
-- 기존 컬럼/인덱스/제약은 건드리지 않는다(회귀 없음).
--
-- Reversible: down.sql 동반(컬럼 + 인덱스 DROP). 플래그는 attachments / 본문에서
-- 언제든 재계산 가능한 파생값이라 손실 무해(down→up 재backfill 로 복원).

ALTER TABLE "Message"
  ADD COLUMN "hasLink"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasImage" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasFile"  BOOLEAN NOT NULL DEFAULT false;

-- ── Backfill: 기존 메시지 ──────────────────────────────────────────────────
-- hasImage / hasFile : 연결된 finalized Attachment 의 kind 에서 유도.
--   IMAGE          → hasImage
--   VIDEO | FILE   → hasFile   (has:video DEFER — 영상도 일단 file 버킷)
-- 본문 textual 첨부는 messageId 로 연결된 행만 대상(presign 후 미연결 제외).
UPDATE "Message" m
   SET "hasImage" = true
 WHERE EXISTS (
   SELECT 1 FROM "Attachment" a
    WHERE a."messageId" = m.id
      AND a."finalizedAt" IS NOT NULL
      AND a."kind" = 'IMAGE'
 );

UPDATE "Message" m
   SET "hasFile" = true
 WHERE EXISTS (
   SELECT 1 FROM "Attachment" a
    WHERE a."messageId" = m.id
      AND a."finalizedAt" IS NOT NULL
      AND a."kind" IN ('FILE', 'VIDEO')
 );

-- hasLink : 본문에 URL 이 있으면 true. 신규 write 경로는 mrkdwn AST 의 `link`
-- 노드(allowlist 스킴)로 권위적으로 판정하지만, 과거 row 는 AST 가 NULL(legacy)
-- 일 수 있으므로 content 텍스트의 http(s):// URL 정규식으로 best-effort 백필한다.
-- 신규/과거 경로가 실사용에서 수렴한다(URL 은 양쪽 모두에 존재).
UPDATE "Message"
   SET "hasLink" = true
 WHERE "content" ~* 'https?://[^[:space:]]+';

-- ── 인덱스: 부분(partial) — 플래그가 true 인 소수 행만 색인 ─────────────────
-- has: 필터는 true 인 메시지만 찾으므로 partial WHERE 로 인덱스를 sparse 하게
-- 유지한다(전체 boolean 인덱스는 선택도가 낮아 무익). channelId 선두로 가시-채널
-- ANY(...) 필터와 합성된다.
CREATE INDEX "Message_channelId_hasLink_idx"  ON "Message" ("channelId") WHERE "hasLink"  = true;
CREATE INDEX "Message_channelId_hasImage_idx" ON "Message" ("channelId") WHERE "hasImage" = true;
CREATE INDEX "Message_channelId_hasFile_idx"  ON "Message" ("channelId") WHERE "hasFile"  = true;
