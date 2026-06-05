import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMrkdwn, type RichTextRoot } from '@qufox/shared-types';
import { renderAst, type MentionLookup } from './renderAst';
import type { CustomEmoji } from '../emojis/api';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function html(raw: string, customs?: Map<string, CustomEmoji>): string {
  const { ast } = parseMrkdwn(raw);
  return renderToStaticMarkup(<>{renderAst(ast, customs)}</>);
}

function htmlOf(ast: RichTextRoot): string {
  return renderToStaticMarkup(<>{renderAst(ast)}</>);
}

describe('renderAst — inline marks (FR-MSG-01)', () => {
  it('renders bold text', () => {
    expect(html('*bold*')).toContain('<strong');
    expect(html('*bold*')).toContain('bold');
  });

  it('renders italic text', () => {
    expect(html('_italic_')).toContain('<em');
  });

  it('renders strike text', () => {
    expect(html('~~gone~~')).toContain('<s');
  });

  it('renders inline code', () => {
    expect(html('`code`')).toContain('qf-code-inline');
  });

  it('renders a spoiler as a maskable element', () => {
    const out = html('||secret||');
    expect(out).toContain('qf-spoiler');
  });
});

describe('renderAst — XSS escape (FR-MSG-20)', () => {
  it('escapes <script> so no script tag reaches the DOM', () => {
    const out = html('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes an injected <img onerror> attempt', () => {
    const out = html('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });
});

describe('renderAst — links (FR-MSG-20)', () => {
  it('renders an http link with rel=noopener noreferrer target=_blank', () => {
    const out = html('[qufox](https://qufox.com)');
    expect(out).toContain('href="https://qufox.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('never emits a javascript: href (sanitized at parse → literal text)', () => {
    const out = html('[x](javascript:alert(1))');
    expect(out).not.toContain('href="javascript:');
  });

  // S78 (FR-MD-01 regression): the link's display text is rendered, not the
  // raw url, while the safe url stays in the href.
  it('renders the link display text (not the raw url) for [text](url)', () => {
    const out = html('[qufox 공식](https://qufox.com)');
    expect(out).toContain('href="https://qufox.com"');
    expect(out).toContain('qufox 공식');
  });

  // S78 (FR-MD-01 regression): a bare url with no display text falls back to
  // rendering the url itself as the link label.
  it('falls back to the url as label when a link AST node has no text', () => {
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [{ type: 'link', url: 'https://qufox.com', text: null }],
        },
      ],
    } as unknown as RichTextRoot;
    const out = htmlOf(ast);
    expect(out).toContain('href="https://qufox.com"');
    expect(out).toContain('https://qufox.com');
  });

  it('hardens a malformed link AST node (defense-in-depth href=#)', () => {
    // Even if a hand-crafted AST carries an unsafe url, the renderer must
    // not emit it as an active href.
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [{ type: 'link', url: 'javascript:alert(1)', text: 'x' }],
        },
      ],
    } as unknown as RichTextRoot;
    const out = htmlOf(ast);
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('href="#"');
  });
});

describe('renderAst — blocks (FR-MSG-01)', () => {
  it('renders a fenced code block with syntax highlight for a known lang (FR-MSG-02)', () => {
    const out = html('```ts\nconst a = 1;\n```');
    expect(out).toContain('qf-codeblock');
    // S04: lang-tagged code blocks are highlighted client-side via
    // highlight.js — the text is split into hljs-* token spans, so we
    // assert the token markup rather than the raw literal.
    expect(out).toContain('data-highlighted="true"');
    expect(out).toContain('hljs-keyword');
  });

  it('renders a fenced code block without lang as plain text (FR-MSG-02 fallback)', () => {
    const out = html('```\nconst a = 1;\n```');
    expect(out).toContain('qf-codeblock');
    expect(out).toContain('data-highlighted="false"');
    expect(out).toContain('const a = 1;');
  });

  it('keeps code-block content literal (no nested markup / xss)', () => {
    const out = html('```\n<b>*x*</b>\n```');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('*x*');
  });

  it('renders a blockquote', () => {
    expect(html('> quoted')).toContain('<blockquote');
  });

  // S78 (FR-MD regression): heading AST nodes (levels 1-3) render as the
  // matching semantic heading element. The live mrkdwn parser doesn't emit
  // `#` headings today (paragraph-only), so the renderer's heading path is
  // exercised with crafted AST nodes (server-built / future parser).
  function headingAst(level: 1 | 2 | 3, text: string): RichTextRoot {
    return {
      type: 'root',
      nodes: [{ type: 'heading', level, nodes: [{ type: 'text', text }] }],
    } as unknown as RichTextRoot;
  }

  it('renders an H1 heading node', () => {
    const out = htmlOf(headingAst(1, 'Title'));
    expect(out).toContain('<h1');
    expect(out).toContain('Title');
  });

  it('renders an H2 heading node', () => {
    const out = htmlOf(headingAst(2, 'Section'));
    expect(out).toContain('<h2');
    expect(out).toContain('Section');
  });

  it('renders an H3 heading node', () => {
    const out = htmlOf(headingAst(3, 'Sub'));
    expect(out).toContain('<h3');
    expect(out).toContain('Sub');
  });

  it('renders an unordered list', () => {
    const out = html('- a\n- b');
    expect(out).toContain('<ul');
    expect(out).toContain('<li');
  });

  it('renders an ordered list', () => {
    const out = html('1. a\n2. b');
    expect(out).toContain('<ol');
  });
});

describe('renderAst — mentions / emoji', () => {
  it('renders a user mention pill', () => {
    const out = html('hi @{clh3z2k0v0000abcd1234ef}');
    expect(out).toContain('qf-mention');
  });

  // S04 FR-MSG-13 (review HIGH): the normalizer stores `@username` as the
  // stable `@{cuid2}` token, so the renderer MUST resolve userId→handle
  // back to the display name. Without the lookup the pill would show the
  // raw cuid — strictly worse than the pre-slice `@username` text.
  it('resolves a user mention to the handle via the mention lookup', () => {
    const { ast } = parseMrkdwn('hi @{clh3z2k0v0000abcd1234ef}');
    const mentions: MentionLookup = {
      userName: (id) => (id === 'clh3z2k0v0000abcd1234ef' ? 'alice' : undefined),
    };
    const out = renderToStaticMarkup(<>{renderAst(ast, undefined, mentions)}</>);
    expect(out).toContain('@alice');
    // the stable id stays on the pill for the click/hover affordance.
    expect(out).toContain('data-user-id="clh3z2k0v0000abcd1234ef"');
    // and the raw cuid must NOT leak into the visible handle text.
    expect(out).not.toContain('@clh3z2k0v0000abcd1234ef');
  });

  it('falls back to the userId when the lookup has no match (never empty pill)', () => {
    const { ast } = parseMrkdwn('hi @{clh3z2k0v0000abcd1234ef}');
    const mentions: MentionLookup = { userName: () => undefined };
    const out = renderToStaticMarkup(<>{renderAst(ast, undefined, mentions)}</>);
    expect(out).toContain('@clh3z2k0v0000abcd1234ef');
    expect(out).toContain('data-user-id="clh3z2k0v0000abcd1234ef"');
  });

  // S04 review HIGH (FR-MSG-13): 서버가 정규화 시점에 해석한 username 을 AST
  // 노드의 label 로 박으므로, 워크스페이스 멤버 맵(lookup)이 아직 없어도 raw
  // cuid 가 아니라 @username 을 그려야 합니다(라이브 렌더 회귀 방지).
  it('renders the AST node label even without a lookup map (live-render regression guard)', () => {
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [{ type: 'mention_user', userId: 'clh3z2k0v0000abcd1234ef', label: 'alice' }],
        },
      ],
    } as unknown as RichTextRoot;
    // no mention lookup passed at all — the label must still surface.
    const out = renderToStaticMarkup(<>{renderAst(ast)}</>);
    expect(out).toContain('@alice');
    expect(out).toContain('data-user-id="clh3z2k0v0000abcd1234ef"');
    expect(out).not.toContain('@clh3z2k0v0000abcd1234ef');
  });

  it('prefers the AST node label over the runtime lookup', () => {
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [{ type: 'mention_user', userId: 'clh3z2k0v0000abcd1234ef', label: 'alice' }],
        },
      ],
    } as unknown as RichTextRoot;
    // lookup says "stale-name"; the persisted label wins.
    const mentions: MentionLookup = { userName: () => 'stale-name' };
    const out = renderToStaticMarkup(<>{renderAst(ast, undefined, mentions)}</>);
    expect(out).toContain('@alice');
    expect(out).not.toContain('stale-name');
  });

  it('renders a channel mention from the AST node label', () => {
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [
            { type: 'mention_channel', channelId: 'clh3z2k0v0000chan1234ab', label: 'general' },
          ],
        },
      ],
    } as unknown as RichTextRoot;
    const out = renderToStaticMarkup(<>{renderAst(ast)}</>);
    expect(out).toContain('#general');
    expect(out).toContain('data-channel-id="clh3z2k0v0000chan1234ab"');
  });

  it('escapes a malicious AST node label (no markup injection)', () => {
    const ast = {
      type: 'root',
      nodes: [
        {
          type: 'paragraph',
          nodes: [
            {
              type: 'mention_user',
              userId: 'clh3z2k0v0000abcd1234ef',
              label: '<script>alert(1)</script>',
            },
          ],
        },
      ],
    } as unknown as RichTextRoot;
    const out = renderToStaticMarkup(<>{renderAst(ast)}</>);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes a malicious handle returned by the lookup (no markup injection)', () => {
    const { ast } = parseMrkdwn('hi @{clh3z2k0v0000abcd1234ef}');
    const mentions: MentionLookup = { userName: () => '<script>alert(1)</script>' };
    const out = renderToStaticMarkup(<>{renderAst(ast, undefined, mentions)}</>);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders a known custom emoji as an img', () => {
    const customs = new Map<string, CustomEmoji>([
      ['party', { id: 'e1', name: 'party', url: 'https://cdn/party.png' } as CustomEmoji],
    ]);
    const ast = {
      type: 'root',
      nodes: [{ type: 'paragraph', nodes: [{ type: 'emoji', name: 'party', customId: 'e1' }] }],
    } as unknown as RichTextRoot;
    const out = renderToStaticMarkup(<>{renderAst(ast, customs)}</>);
    expect(out).toContain('qf-emoji-custom');
  });
});

describe('renderAst — empty / null', () => {
  it('renders nothing for an empty root', () => {
    expect(htmlOf({ type: 'root', nodes: [] })).toBe('');
  });
});
