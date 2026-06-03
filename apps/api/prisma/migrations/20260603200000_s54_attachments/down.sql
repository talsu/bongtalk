-- Reverse of S54 첨부 도메인 확장 + 업로드 세션 + 읽음 처리 모드.
--
-- 역순으로 되돌린다: (1) 세션 테이블 DROP(인덱스/FK 동반 DROP), (2) Attachment
-- 확장 컬럼 DROP, (3) UserSettings.markAsReadMode DROP, (4) enum DROP. 전 단계
-- IF EXISTS 가드. additive 신규 컬럼/테이블/enum 이라 다운그레이드 손실은 S54 의
-- 첨부 메타(thumbnailKey/altText/spoiler 등)·업로드 세션·읽음 모드에 한정된다
-- (기존 Attachment/UserSettings 행 + 기존 컬럼은 무영향). enum 은 의존 컬럼을 먼저
-- 떨어뜨린 뒤 DROP 한다(역순 보장).

-- (1) 세션 테이블 — 인덱스/FK 는 테이블 DROP 으로 함께 제거된다.
DROP TABLE IF EXISTS "AttachmentUploadSession";

-- (2) Attachment 확장 컬럼.
ALTER TABLE "Attachment"
  DROP COLUMN IF EXISTS "processingStatus",
  DROP COLUMN IF EXISTS "linkedAt",
  DROP COLUMN IF EXISTS "sortOrder",
  DROP COLUMN IF EXISTS "isSpoiler",
  DROP COLUMN IF EXISTS "altText",
  DROP COLUMN IF EXISTS "duration",
  DROP COLUMN IF EXISTS "height",
  DROP COLUMN IF EXISTS "width",
  DROP COLUMN IF EXISTS "extension",
  DROP COLUMN IF EXISTS "storedMimeType",
  DROP COLUMN IF EXISTS "thumbnailKey";

-- (3) UserSettings.markAsReadMode.
ALTER TABLE "UserSettings"
  DROP COLUMN IF EXISTS "markAsReadMode";

-- (4) enum — 의존 컬럼 제거 후 DROP.
DROP TYPE IF EXISTS "MarkAsReadMode";
DROP TYPE IF EXISTS "AttachmentStatus";
