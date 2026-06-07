-- Reverse of S84c 링크 미리보기 전역 비활성화.
-- 단일 ADDITIVE 컬럼 DROP. 다운그레이드 손실은 사용자별 링크 미리보기 토글 값에 한정되며
-- 기존 외관/알림 설정 컬럼은 무영향(다운그레이드 후 모두 기본 동작=링크 미리보기 ON).
ALTER TABLE "UserSettings" DROP COLUMN IF EXISTS "linkPreviewsEnabled";
