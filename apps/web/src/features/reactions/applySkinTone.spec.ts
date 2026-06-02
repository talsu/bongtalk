import { describe, it, expect } from 'vitest';
import { applySkinTone } from './EmojiPicker';

/**
 * S42 (FR-PK03): 큐레이션 글리프에 기본 스킨톤 수정자를 덧붙인다. tone 1(기본) 은
 * 변형 없음, 2-6 은 피츠패트릭 수정자 codepoint 를 append 한다. 범위 밖은 무변형.
 */
describe('applySkinTone (FR-PK03)', () => {
  it('returns the glyph unchanged for tone 1 (default)', () => {
    expect(applySkinTone('👍', 1)).toBe('👍');
  });

  it('appends a Fitzpatrick modifier for tones 2-6', () => {
    expect(applySkinTone('👍', 3)).toBe('👍\u{1F3FC}');
    expect(applySkinTone('👍', 6)).toBe('👍\u{1F3FF}');
  });

  it('returns the glyph unchanged for out-of-range tones', () => {
    expect(applySkinTone('👍', 0)).toBe('👍');
    expect(applySkinTone('👍', 7)).toBe('👍');
  });
});
