-- Reverse of S55 첨부 정책 + orphan GC 인덱스.
--
-- 역순으로 되돌린다: (1) Attachment/세션 partial 인덱스 DROP, (2) WorkspaceSetting
-- 테이블 DROP(인덱스/FK 동반), (3) Channel 신규 컬럼 DROP. 전 단계 IF EXISTS 가드.
-- additive 신규 컬럼/테이블/인덱스라 다운그레이드 손실은 S55 의 첨부 정책(채널 토글/
-- 크기 상한·워크스페이스 설정)에 한정된다(기존 Channel/Attachment 행은 무영향).

-- (1) partial 인덱스(역순).
DROP INDEX IF EXISTS "AttachmentUploadSession_open_expiresAt_idx";
DROP INDEX IF EXISTS "Attachment_orphan_createdAt_idx";
DROP INDEX IF EXISTS "Attachment_processingStatus_pending_idx";

-- (2) WorkspaceSetting 테이블 — 유니크 인덱스/FK 는 테이블 DROP 으로 함께 제거된다.
DROP TABLE IF EXISTS "WorkspaceSetting";

-- (3) Channel 신규 컬럼.
ALTER TABLE "Channel"
  DROP COLUMN IF EXISTS "maxFileSizeBytes",
  DROP COLUMN IF EXISTS "fileUploadEnabled";
