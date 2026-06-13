import { EMOJI_CATEGORIES } from '../../reactions/EmojiPicker';
import type { EmojiCandidate } from './filterEmojis';

/**
 * S18 (FR-RC05) — 유니코드 이모지 shortcode 이름 ↔ 글리프 매핑.
 *
 * 기존 EmojiPicker 의 curated 팔레트(글리프만 보유)를 재사용하되, `:` 자동완성
 * 이 부분 일치할 shortcode 이름을 함께 보유합니다. emoji-mart 같은 전체
 * 라이브러리(~1800 entries)는 번들을 키우므로, 팔레트에 실린 글리프에
 * 한정해 hand-curated 이름을 답니다(EmojiPicker 의 thin-bundle 정책과 동일).
 *
 * 같은 글리프가 복수 카테고리에 중복 등장하면(예: 👍, ❤️, 🎉) 첫 등장만
 * 매핑에 남깁니다.
 */
import { GLYPH_TO_NAME } from './emojiGlyphNames';

/** 자동완성 후보로 쓸 유니코드 이모지 목록(이름 보유분만). */
export const UNICODE_EMOJI_CANDIDATES: EmojiCandidate[] = (() => {
  const seen = new Set<string>();
  const out: EmojiCandidate[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const glyph of category.emojis) {
      if (seen.has(glyph)) continue;
      const name = GLYPH_TO_NAME[glyph];
      if (!name) continue;
      seen.add(glyph);
      out.push({ kind: 'unicode', name, glyph });
    }
  }
  return out;
})();
