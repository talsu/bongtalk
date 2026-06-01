import { describe, it, expect } from 'vitest';
import type { RichTextRoot } from '@qufox/shared-types';
import { astHasLink, flagsFromAttachmentKinds } from '../../../src/search/message-flags';

/**
 * S29 (FR-S05): 비정규화 검색 플래그 계산 단위 검증.
 *  - astHasLink: 어떤 깊이의 link 노드든 탐지(paragraph / blockquote / list).
 *  - flagsFromAttachmentKinds: IMAGE→hasImage, FILE/VIDEO→hasFile.
 */

function paragraph(...nodes: unknown[]): unknown {
  return { type: 'paragraph', nodes };
}

describe('astHasLink (S29)', () => {
  it('null/undefined → false', () => {
    expect(astHasLink(null)).toBe(false);
    expect(astHasLink(undefined)).toBe(false);
  });

  it('링크 없는 본문 → false', () => {
    const ast = { type: 'root', nodes: [paragraph({ type: 'text', text: 'no link here' })] };
    expect(astHasLink(ast as unknown as RichTextRoot)).toBe(false);
  });

  it('paragraph 안 link 노드 → true', () => {
    const ast = {
      type: 'root',
      nodes: [paragraph({ type: 'text', text: 'see ' }, { type: 'link', url: 'https://x.io' })],
    };
    expect(astHasLink(ast as unknown as RichTextRoot)).toBe(true);
  });

  it('blockquote 중첩 link → true', () => {
    const ast = {
      type: 'root',
      nodes: [{ type: 'blockquote', nodes: [paragraph({ type: 'link', url: 'https://y.io' })] }],
    };
    expect(astHasLink(ast as unknown as RichTextRoot)).toBe(true);
  });

  it('list item 중첩 link → true', () => {
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'list',
          ordered: false,
          indent: 0,
          items: [{ nodes: [paragraph({ type: 'link', url: 'https://z.io' })] }],
        },
      ],
    };
    expect(astHasLink(ast as unknown as RichTextRoot)).toBe(true);
  });
});

describe('flagsFromAttachmentKinds (S29)', () => {
  it('빈 집합 → 둘 다 false', () => {
    expect(flagsFromAttachmentKinds([])).toEqual({ hasImage: false, hasFile: false });
  });
  it('IMAGE → hasImage', () => {
    expect(flagsFromAttachmentKinds(['IMAGE'])).toEqual({ hasImage: true, hasFile: false });
  });
  it('FILE / VIDEO → hasFile', () => {
    expect(flagsFromAttachmentKinds(['FILE'])).toEqual({ hasImage: false, hasFile: true });
    expect(flagsFromAttachmentKinds(['VIDEO'])).toEqual({ hasImage: false, hasFile: true });
  });
  it('혼합 → 둘 다 true', () => {
    expect(flagsFromAttachmentKinds(['IMAGE', 'FILE'])).toEqual({ hasImage: true, hasFile: true });
  });
});
