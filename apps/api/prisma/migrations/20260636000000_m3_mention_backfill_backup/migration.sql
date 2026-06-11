-- 071-M3 F10 (M1 이월 — 멘션 토큰 백필): 재파싱 전 구값 백업 테이블.
--
-- M1 에서 MENTION_USER_RE/MENTION_CHANNEL_RE 가 uuid 를 수용하도록 수리되기 전
-- 저장된 Message 행들은 contentAst 의 멘션이 평문 text 노드(@{uuid}/<#uuid>)로
-- 박혀 있다. 백필 잡(mention-backfill.processor)이 contentRaw 재파싱으로
-- contentAst/contentPlain 만 갱신하며(updatedAt/version/editedAt 불변), 갱신 전
-- 구값을 본 테이블에 적재해 되돌림(reversible)을 보장한다.
--
-- 되돌림 절차(수동):
--   UPDATE "Message" m SET "contentAst" = b.content_ast_old,
--                          "contentPlain" = b.content_plain_old
--   FROM "MentionBackfillBackup" b WHERE b.message_id = m.id;
-- 소킹 후 폐기: DROP TABLE "MentionBackfillBackup";
CREATE TABLE IF NOT EXISTS "MentionBackfillBackup" (
  "message_id"        UUID PRIMARY KEY,
  "content_ast_old"   JSONB,
  "content_plain_old" TEXT NOT NULL,
  "backed_up_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
