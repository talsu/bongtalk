import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RichTextRoot, InlineNode } from '@qufox/shared-types';
import { isJumboEmoji } from './jumboEmoji';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function emoji(name: string): InlineNode {
  return { type: 'emoji', name, customId: null };
}
function text(t: string): InlineNode {
  return { type: 'text', text: t, marks: [] };
}
function paragraph(nodes: InlineNode[]): RichTextRoot {
  return { type: 'root', nodes: [{ type: 'paragraph', nodes }] };
}

describe('isJumboEmoji (FR-RC15)', () => {
  it('이모지 1개 only → true', () => {
    expect(isJumboEmoji(paragraph([emoji('smile')]))).toBe(true);
  });

  it('이모지 3개 only → true', () => {
    expect(isJumboEmoji(paragraph([emoji('a'), emoji('b'), emoji('c')]))).toBe(true);
  });

  it('이모지 사이 공백 text 는 무시하고 true', () => {
    expect(isJumboEmoji(paragraph([emoji('a'), text('  '), emoji('b')]))).toBe(true);
  });

  it('이모지 4개 → false (한도 초과)', () => {
    expect(isJumboEmoji(paragraph([emoji('a'), emoji('b'), emoji('c'), emoji('d')]))).toBe(false);
  });

  it('이모지 + 텍스트 혼합 → false', () => {
    expect(isJumboEmoji(paragraph([emoji('a'), text('hi')]))).toBe(false);
  });

  it('빈 paragraph(이모지 0개) → false', () => {
    expect(isJumboEmoji(paragraph([]))).toBe(false);
  });

  it('일반 텍스트 → false', () => {
    expect(isJumboEmoji(paragraph([text('hello')]))).toBe(false);
  });

  it('블록이 2개 이상이면 false', () => {
    const ast: RichTextRoot = {
      type: 'root',
      nodes: [
        { type: 'paragraph', nodes: [emoji('a')] },
        { type: 'paragraph', nodes: [emoji('b')] },
      ],
    };
    expect(isJumboEmoji(ast)).toBe(false);
  });

  it('단일 블록이 paragraph 가 아니면 false', () => {
    const ast: RichTextRoot = {
      type: 'root',
      nodes: [{ type: 'heading', level: 1, nodes: [emoji('a')] }],
    };
    expect(isJumboEmoji(ast)).toBe(false);
  });

  it('null / undefined → false', () => {
    expect(isJumboEmoji(null)).toBe(false);
    expect(isJumboEmoji(undefined)).toBe(false);
  });
});
