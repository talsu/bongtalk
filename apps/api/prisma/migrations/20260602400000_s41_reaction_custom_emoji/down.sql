-- Reverse of S41 custom-emoji reaction support.
--
-- up 의 정확한 역순(인덱스 → FK → 컬럼)으로 떼낸다. customEmojiId 는 nullable
-- 파생 참조라(emoji 컬럼에 `:name:` 슬러그가 별도 보존됨) 컬럼을 떼도 반응 행
-- 자체와 유니코드 반응은 손실이 없다. 커스텀 이모지 반응은 emoji=`:name:` 텍스트로
-- 남으나 customEmojiId 링크만 사라진다(다운그레이드 후 placeholder/이미지 구분 불가
-- — 의도된 역연산 손실, 데이터 자체는 보존).

DROP INDEX IF EXISTS "MessageReaction_customEmojiId_idx";

ALTER TABLE "MessageReaction"
  DROP CONSTRAINT IF EXISTS "MessageReaction_customEmojiId_fkey";

ALTER TABLE "MessageReaction"
  DROP COLUMN IF EXISTS "customEmojiId";
