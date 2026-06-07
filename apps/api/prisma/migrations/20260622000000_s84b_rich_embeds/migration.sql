-- S84b (D16 / FR-RC12) — 봇/웹훅 rich embed 배열.
--
-- Message 에 ADDITIVE nullable JSON 컬럼 1개(richEmbeds)를 추가한다. 봇/웹훅 메시지가
-- 게시 시점에 통째 제공하는 Discord 스타일 rich embed 배열(≤10 embed × ≤25 field)을
-- 자족적으로 담는다(별도 테이블 없음 — mentions/contentAst JSON 선례). 전부 ADDITIVE +
-- reversible. 기존 row 는 NULL(embed 없음)이라 무영향. CONCURRENTLY 미사용(단일 컬럼
-- 추가라 즉시 완료 · prisma migrate deploy 의 단일 트랜잭션과 호환). 멱등(IF NOT EXISTS).

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "richEmbeds" JSONB;
