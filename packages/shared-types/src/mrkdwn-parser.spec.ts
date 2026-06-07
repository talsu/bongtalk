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

// S78 reviewer B1 (FR-MD-01 P0): the parser must tokenize `# H1`-`### H3`
// headings into heading nodes (level = number of leading hashes). The
// renderer + AST schema already supported heading nodes, but parseBlocks let
// `#` lines fall through to a paragraph, so the live syntax was a no-op.
describe('parseMrkdwn — heading syntax (FR-MD-01)', () => {
  it('parses `# H1` into a heading node at level 1', () => {
    const { ast } = parseMrkdwn('# Title');
    expect(ast.nodes[0]).toMatchObject({ type: 'heading', level: 1 });
  });

  it('parses `## H2` into a heading node at level 2', () => {
    const { ast } = parseMrkdwn('## Section');
    expect(ast.nodes[0]).toMatchObject({ type: 'heading', level: 2 });
  });

  it('parses `### H3` into a heading node at level 3', () => {
    const { ast } = parseMrkdwn('### Sub');
    expect(ast.nodes[0]).toMatchObject({ type: 'heading', level: 3 });
  });

  it('parses heading inline content (e.g. *bold*) into the heading nodes', () => {
    const { ast } = parseMrkdwn('# *bold* head');
    const head = ast.nodes[0] as { type: string; nodes: TextNode[] };
    expect(head.type).toBe('heading');
    const boldNode = head.nodes.find((n) => n.type === 'text' && n.marks?.includes('bold'));
    expect(boldNode).toBeTruthy();
  });

  it('treats `#tag` without a following space as a paragraph (not a heading)', () => {
    const { ast } = parseMrkdwn('#tag');
    expect(ast.nodes[0].type).toBe('paragraph');
  });

  it('treats `#### H4` (4+ hashes, over level cap) as a paragraph', () => {
    const { ast } = parseMrkdwn('#### too deep');
    expect(ast.nodes[0].type).toBe('paragraph');
  });

  it('breaks a paragraph run at a heading line', () => {
    const { ast } = parseMrkdwn('intro line\n# Heading\noutro line');
    expect(ast.nodes[0].type).toBe('paragraph');
    expect(ast.nodes[1]).toMatchObject({ type: 'heading', level: 1 });
    expect(ast.nodes[2].type).toBe('paragraph');
  });

  it('produces a schema-valid root for a heading', () => {
    const { ast } = parseMrkdwn('## Section');
    expect(isRichTextRoot(ast)).toBe(true);
  });
});

describe('parseMrkdwn — mention tokens (FR-RC02 / FR-RC22)', () => {
  it('parses @{cuid2} into a mention_user node', () => {
    const p = firstParagraph('hi @{clh3z2k0v0000abcd1234ef}');
    const mention = p.nodes.find((n) => n.type === 'mention_user');
    expect(mention).toMatchObject({ type: 'mention_user', userId: 'clh3z2k0v0000abcd1234ef' });
  });

  it('leaves the mention_user label undefined when no resolver is given (legacy)', () => {
    const p = firstParagraph('hi @{clh3z2k0v0000abcd1234ef}');
    const mention = p.nodes.find((n) => n.type === 'mention_user');
    expect(mention).toMatchObject({ type: 'mention_user', userId: 'clh3z2k0v0000abcd1234ef' });
    expect((mention as { label?: string }).label).toBeUndefined();
  });

  // S88a (FR-MN-03): <@&uuid|cuid2> 역할 토큰을 mention_role 노드로 파싱한다.
  it('parses <@&uuid> into a mention_role node (Role.id = @db.Uuid)', () => {
    const p = firstParagraph('ping <@&3f2504e0-4f89-41d3-9a0c-0305e82c3301>');
    const mention = p.nodes.find((n) => n.type === 'mention_role');
    expect(mention).toMatchObject({
      type: 'mention_role',
      roleId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
  });

  it('leaves mention_role.label undefined when no role resolver is given (legacy)', () => {
    const p = firstParagraph('ping <@&3f2504e0-4f89-41d3-9a0c-0305e82c3301>');
    const mention = p.nodes.find((n) => n.type === 'mention_role');
    expect((mention as { label?: string }).label).toBeUndefined();
  });
});

// S04 review HIGH (FR-MSG-13): 정규화는 @username 을 @{cuid2} 로 저장하므로
// 파서가 mention 노드에 표시명(label)을 박을 수 있어야, 라이브 렌더가 멤버 맵
// 도착 전에도 raw cuid 가 아니라 @username 을 그립니다(회귀 방지).
describe('parseMrkdwn — mention label injection (S04 review HIGH / FR-MSG-13)', () => {
  it('populates mention_user.label from the user resolver', () => {
    const { ast } = parseMrkdwn('hi @{clh3z2k0v0000abcd1234ef}', {
      mentionLabels: { user: (id) => (id === 'clh3z2k0v0000abcd1234ef' ? 'alice' : undefined) },
    });
    const p = ast.nodes[0] as ParagraphNode;
    const mention = p.nodes.find((n) => n.type === 'mention_user');
    expect(mention).toMatchObject({
      type: 'mention_user',
      userId: 'clh3z2k0v0000abcd1234ef',
      label: 'alice',
    });
  });

  it('populates mention_channel.label from the channel resolver', () => {
    const { ast } = parseMrkdwn('see <#clh3z2k0v0000chan1234ab>', {
      mentionLabels: {
        channel: (id) => (id === 'clh3z2k0v0000chan1234ab' ? 'general' : undefined),
      },
    });
    const p = ast.nodes[0] as ParagraphNode;
    const mention = p.nodes.find((n) => n.type === 'mention_channel');
    expect(mention).toMatchObject({
      type: 'mention_channel',
      channelId: 'clh3z2k0v0000chan1234ab',
      label: 'general',
    });
  });

  it('omits label when the resolver returns undefined / null / empty', () => {
    for (const ret of [undefined, null, '', '   '] as const) {
      const { ast } = parseMrkdwn('hi @{clh3z2k0v0000abcd1234ef}', {
        mentionLabels: { user: () => ret },
      });
      const p = ast.nodes[0] as ParagraphNode;
      const mention = p.nodes.find((n) => n.type === 'mention_user');
      expect((mention as { label?: string }).label).toBeUndefined();
    }
  });

  it('populates mention_role.label from the role resolver (S88a / FR-MN-03)', () => {
    const { ast } = parseMrkdwn('ping <@&3f2504e0-4f89-41d3-9a0c-0305e82c3301>', {
      mentionLabels: {
        role: (id) => (id === '3f2504e0-4f89-41d3-9a0c-0305e82c3301' ? 'Project Managers' : null),
      },
    });
    const p = ast.nodes[0] as ParagraphNode;
    const mention = p.nodes.find((n) => n.type === 'mention_role');
    expect(mention).toMatchObject({
      type: 'mention_role',
      roleId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      label: 'Project Managers',
    });
  });

  it('still produces a schema-valid root with labels present', () => {
    const { ast } = parseMrkdwn('hi @{clh3z2k0v0000abcd1234ef}', {
      mentionLabels: { user: () => 'alice' },
    });
    expect(isRichTextRoot(ast)).toBe(true);
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
