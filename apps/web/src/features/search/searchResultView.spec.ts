import { describe, it, expect } from 'vitest';
import {
  IN_THREAD_LABEL,
  INDEX_UPDATE_BANNER_TEXT,
  MASKED_CONTEXT_PLACEHOLDER,
  contextDisplayText,
  emptyStateHint,
} from './searchResultView';

describe('searchResultView (S30 pure helpers)', () => {
  it('FR-S03: emptyStateHint 는 검색어 + 수식어 안내를 포함', () => {
    const hint = emptyStateHint('roadmap');
    expect(hint).toContain("'roadmap'");
    expect(hint).toContain('결과 없음');
    expect(hint).toContain('from:, in:, has:');
  });

  it('FR-S06: 마스킹이면 placeholder, 아니면 본문 그대로', () => {
    expect(contextDisplayText({ masked: true, text: null })).toBe(MASKED_CONTEXT_PLACEHOLDER);
    expect(contextDisplayText({ masked: false, text: null })).toBe(MASKED_CONTEXT_PLACEHOLDER);
    expect(contextDisplayText({ masked: false, text: 'visible body' })).toBe('visible body');
  });

  it('상수 문구(존댓말/레이블) 고정', () => {
    expect(IN_THREAD_LABEL).toBe('In Thread');
    expect(INDEX_UPDATE_BANNER_TEXT).toContain('재검색');
  });
});
