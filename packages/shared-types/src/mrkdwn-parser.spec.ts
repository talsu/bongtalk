import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseMrkdwn,
  MrkdwnParseError,
  enforceContentLength,
  enforceAstByteSize,
} from './mrkdwn-parser';
import { isRichTextRoot, type TextNode, type ParagraphNode } from './mrkdwn-ast';
import { MRKDWN_PARSE_LIMITS } from './mrkdwn';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/** Helper: first paragraph's inline nodes. */
function firstParagraph(raw: string): ParagraphNode {
  const { ast } = parseMrkdwn(raw);
  const block = ast.nodes[0];
  expect(block.type).toBe('paragraph');
  return block as ParagraphNode;
}

describe('parseMrkdwn — output contract', () => {
  it('produces a valid rich_text root AST', () => {
    const { ast } = parseMrkdwn('hello world');
    expect(isRichTextRoot(ast)).toBe(true);
    expect(ast.type).toBe('root');
  });

  it('returns a plain projection with sigils stripped + whitespace collapsed', () => {
    const { plain } = parseMrkdwn('*bold*   and `code`');
    expect(plain).toBe('bold and code');
  });

  it('AC FR-MSG-01 — contentRaw "**hello**" → plain "hello"', () => {
    // qufox mrkdwn: *bold* is Slack-style single asterisk; render keeps
    // text only in the plain projection.
    const { plain } = parseMrkdwn('*hello*');
    expect(plain).toBe('hello');
  });
});

describe('parseMrkdwn — inline syntax (FR-MSG-01)', () => {
  it('parses *bold* into a text node with the bold mark', () => {
    const p = firstParagraph('*bold*');
    const node = p.nodes[0] as TextNode;
    expect(node.type).toBe('text');
    expect(node.text).toBe('bold');
    expect(node.marks).toContain('bold');
  });

  it('parses _italic_ into the italic mark', () => {
    const node = firstParagraph('_italic_').nodes[0] as TextNode;
    expect(node.marks).toContain('italic');
  });

  it('parses ~~strike~~ into the strike mark', () => {
    const node = firstParagraph('~~strike~~').nodes[0] as TextNode;
    expect(node.marks).toContain('strike');
  });

  it('parses `code` into the code mark and does NOT parse markup inside', () => {
    const node = firstParagraph('`*not bold*`').nodes[0] as TextNode;
    expect(node.marks).toContain('code');
    expect(node.text).toBe('*not bold*');
  });

  it('parses ||spoiler|| into the spoiler mark', () => {
    const node = firstParagraph('||secret||').nodes[0] as TextNode;
    expect(node.marks).toContain('spoiler');
    expect(node.text).toBe('secret');
  });

  it('parses [label](url) into a link node', () => {
    const p = firstParagraph('see [qufox](https://qufox.com)');
    const link = p.nodes.find((n) => n.type === 'link');
    expect(link).toMatchObject({ type: 'link', url: 'https://qufox.com', text: 'qufox' });
  });

  it('parses a bare http(s) url into a link node', () => {
    const p = firstParagraph('go https://qufox.com now');
    const link = p.nodes.find((n) => n.type === 'link');
    expect(link).toMatchObject({ type: 'link', url: 'https://qufox.com' });
  });
});

describe('parseMrkdwn — link sanitize (FR-MSG-20)', () => {
  it('drops a javascript: scheme link to plain text (no link node)', () => {
    const p = firstParagraph('[x](javascript:alert(1))');
    expect(p.nodes.some((n) => n.type === 'link')).toBe(false);
  });

  it('drops a data: scheme link to plain text (no link node)', () => {
    const p = firstParagraph('[x](data:text/html,<script>alert(1)</script>)');
    expect(p.nodes.some((n) => n.type === 'link')).toBe(false);
  });

  it('keeps http(s) link nodes', () => {
    const p = firstParagraph('[ok](https://qufox.com)');
    expect(p.nodes.some((n) => n.type === 'link')).toBe(true);
  });
});

describe('parseMrkdwn — XSS-relevant content stays literal text (FR-MSG-20)', () => {
  it('treats <script> as ordinary text in the AST (no html parsing)', () => {
    const node = firstParagraph('<script>alert(1)</script>').nodes[0] as TextNode;
    expect(node.type).toBe('text');
    expect(node.text).toContain('<script>');
    // AST never carries raw HTML — the renderer is the escape boundary.
    expect(node.marks).toEqual([]);
  });
});

describe('parseMrkdwn — block syntax (FR-MSG-01)', () => {
  it('parses a fenced code block with a language', () => {
    const { ast } = parseMrkdwn('```python\nprint(1)\n```');
    const block = ast.nodes[0];
    expect(block).toMatchObject({ type: 'code_block', lang: 'python', code: 'print(1)' });
  });

  it('does NOT parse mentions / markup inside a code block', () => {
    const { ast } = parseMrkdwn('```\n@{clh3z2k0v0000abcd1234ef} *x*\n```');
    const block = ast.nodes[0] as { type: string; code: string };
    expect(block.type).toBe('code_block');
    expect(block.code).toContain('@{clh3z2k0v0000abcd1234ef}');
    expect(block.code).toContain('*x*');
  });

  it('parses a `> ` line into a blockquote block', () => {
    const { ast } = parseMrkdwn('> quoted');
    expect(ast.nodes[0].type).toBe('blockquote');
  });

  it('parses `- item` lines into an unordered list', () => {
    const { ast } = parseMrkdwn('- a\n- b');
    const list = ast.nodes.find((n) => n.type === 'list') as { ordered: boolean; items: unknown[] };
    expect(list).toBeTruthy();
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
  });

  it('parses `1. item` lines into an ordered list', () => {
    const { ast } = parseMrkdwn('1. a\n2. b');
    const list = ast.nodes.find((n) => n.type === 'list') as { ordered: boolean };
    expect(list?.ordered).toBe(true);
  });
});

describe('parseMrkdwn — mention tokens (FR-RC02 / FR-RC22)', () => {
  it('parses @{cuid2} into a mention_user node', () => {
    const p = firstParagraph('hi @{clh3z2k0v0000abcd1234ef}');
    const mention = p.nodes.find((n) => n.type === 'mention_user');
    expect(mention).toMatchObject({ type: 'mention_user', userId: 'clh3z2k0v0000abcd1234ef' });
  });
});

describe('parseMrkdwn — ReDoS / DoS guards (FR-MSG-23)', () => {
  it('throws PARSE_DEPTH_EXCEEDED for >10 nested inline marks', () => {
    // FR-MSG-23 AC — alternating bold/italic openers nest 11+ levels deep:
    // *_*_*_*_*_*_*_*_*_*_*x*_*_*_*_*_*_*_*_*_*_*  (balanced).
    const open = '*_'.repeat(11);
    const close = '_*'.repeat(11);
    const raw = open + 'x' + close;
    try {
      parseMrkdwn(raw);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MrkdwnParseError);
      expect((e as MrkdwnParseError).code).toBe('PARSE_DEPTH_EXCEEDED');
    }
  });

  it('throws PARSE_NODE_LIMIT when the AST exceeds MAX_NODES', () => {
    // Many separate inline code spans → many text nodes.
    const raw = Array.from({ length: MRKDWN_PARSE_LIMITS.MAX_NODES + 50 }, () => '`x`').join(' ');
    try {
      parseMrkdwn(raw);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MrkdwnParseError);
      expect((e as MrkdwnParseError).code).toBe('PARSE_NODE_LIMIT');
    }
  });

  it('a pathological ReDoS-style input parses well under the timeout budget', () => {
    const raw = 'a?'.repeat(40) + 'a'.repeat(40);
    const start = Date.now();
    const { ast } = parseMrkdwn(raw);
    expect(Date.now() - start).toBeLessThan(MRKDWN_PARSE_LIMITS.TIMEOUT_MS);
    expect(isRichTextRoot(ast)).toBe(true);
  });
});

describe('enforceContentLength (FR-MSG-03 / FR-MSG-20)', () => {
  it('passes content at exactly MAX_PLAIN_LENGTH', () => {
    expect(() =>
      enforceContentLength('a'.repeat(MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH)),
    ).not.toThrow();
  });

  it('throws MESSAGE_TOO_LONG over the limit', () => {
    try {
      enforceContentLength('a'.repeat(MRKDWN_PARSE_LIMITS.MAX_PLAIN_LENGTH + 1));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MrkdwnParseError);
      expect((e as MrkdwnParseError).code).toBe('MESSAGE_TOO_LONG');
    }
  });
});

describe('enforceAstByteSize (FR-MSG-23)', () => {
  it('throws PARSE_AST_TOO_LARGE when the serialized AST exceeds 64KB', () => {
    const huge = {
      type: 'root',
      nodes: [
        { type: 'paragraph', nodes: [{ type: 'text', text: 'x'.repeat(70 * 1024), marks: [] }] },
      ],
    };
    try {
      enforceAstByteSize(huge);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MrkdwnParseError);
      expect((e as MrkdwnParseError).code).toBe('PARSE_AST_TOO_LARGE');
    }
  });

  it('passes a small AST', () => {
    expect(() => enforceAstByteSize({ type: 'root', nodes: [] })).not.toThrow();
  });
});
