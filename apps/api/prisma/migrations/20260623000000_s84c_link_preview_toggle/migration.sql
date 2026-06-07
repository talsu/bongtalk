-- S84c (D16 / FR-RC19) — 링크 미리보기 전역 비활성화.
--
-- UserSettings 에 ADDITIVE 컬럼(linkPreviewsEnabled) 1개를 추가한다. 사용자가 링크
-- 미리보기(unfurl OG 카드)를 전역으로 끌 수 있는 표시 환경설정이다. DEFAULT true 라
-- 기존 row/사용자는 종전대로 링크 미리보기를 본다(회귀 없음). ADDITIVE + reversible.
-- CONCURRENTLY 미사용(단일 컬럼 + DEFAULT 라 즉시 완료 · 단일 트랜잭션 호환). 멱등.

ALTER TABLE "UserSettings"
  ADD COLUMN IF NOT EXISTS "linkPreviewsEnabled" BOOLEAN NOT NULL DEFAULT true;
