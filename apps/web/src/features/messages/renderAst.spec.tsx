import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMrkdwn, type RichTextRoot } from '@qufox/shared-types';
import { renderAst } from './renderAst';
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
  it('renders a fenced code block', () => {
    const out = html('```ts\nconst a = 1;\n```');
    expect(out).toContain('qf-codeblock');
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
