-- S41 (D05 / FR-EM06 / FR-RC20) — 커스텀 이모지 반응 지원.
--
-- ADDITIVE + reversible. MessageReaction 에 nullable FK 1개 + 보조 인덱스 1개를
-- 더한다(기존 row 는 customEmojiId = NULL 로 백필 불요 — 유니코드 반응):
--
--   1. MessageReaction.customEmojiId UUID NULL
--      커스텀 이모지 반응이면 참조 CustomEmoji.id, 유니코드 반응이면 NULL.
--      `emoji` 컬럼에는 일관 식별자 `:name:` 를 함께 저장하므로, 커스텀 이모지가
--      삭제돼 이 FK 가 SetNull 로 풀려도 원래 슬러그가 보존된다(FR-EM06 placeholder).
--
--   2. FK MessageReaction.customEmojiId → CustomEmoji.id ON DELETE SET NULL
--      CustomEmoji 삭제 시 참조 반응 행은 보존하되(반응 카운트 유지) 이 FK 만 NULL
--      로 풀린다. ON DELETE CASCADE 가 아니라 SET NULL 인 이유 = FR-EM06 회귀:
--      삭제된 커스텀 이모지 반응도 [삭제된 이모지] placeholder 로 계속 보여야 한다.
--
--   3. (customEmojiId) 인덱스
--      삭제 전 "이 이모지를 쓰는 반응이 있나" 조회 / SetNull 동작 보조.
--
-- down.sql 이 인덱스 → FK → 컬럼 순서로 DROP 한다(역순). PG16 throwaway DB 로
-- up→down→up 검증. 전 DDL 을 멱등으로 감싼다(s33/s38 IF NOT EXISTS 패턴 일관):
-- 컬럼은 ADD COLUMN IF NOT EXISTS, 인덱스는 CREATE INDEX IF NOT EXISTS, FK 는
-- 제약 존재검사(DO $$ … IF NOT EXISTS (pg_constraint) … ADD CONSTRAINT …).

-- 1. MessageReaction.customEmojiId (additive nullable → 기존 row 안전).
ALTER TABLE "MessageReaction"
  ADD COLUMN IF NOT EXISTS "customEmojiId" UUID;

-- 2. FK → CustomEmoji ON DELETE SET NULL (제약 존재검사 — ADD CONSTRAINT 은
--    IF NOT EXISTS 미지원이라 pg_constraint 로 가드).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MessageReaction_customEmojiId_fkey'
  ) THEN
    ALTER TABLE "MessageReaction"
      ADD CONSTRAINT "MessageReaction_customEmojiId_fkey"
      FOREIGN KEY ("customEmojiId") REFERENCES "CustomEmoji"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- 3. (customEmojiId) 보조 인덱스.
CREATE INDEX IF NOT EXISTS "MessageReaction_customEmojiId_idx"
  ON "MessageReaction" ("customEmojiId");
