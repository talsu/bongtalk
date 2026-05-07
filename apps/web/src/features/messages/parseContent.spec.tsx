import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMessageContent } from './parseContent';
import type { CustomEmoji } from '../emojis/api';

function toHtml(input: string, customs?: Map<string, CustomEmoji>): string {
  const nodes = renderMessageContent(input, customs);
  return renderToStaticMarkup(<>{nodes}</>);
}

describe('renderMessageContent', () => {
  it('passes through plain text', () => {
    expect(toHtml('hello world')).toBe('hello world');
  });

  it('converts inline backticks to qf-code-inline', () => {
    expect(toHtml('use `--r-xl`')).toBe('use <code class="qf-code-inline">--r-xl</code>');
  });

  it('converts fenced blocks to qf-codeblock with optional lang', () => {
    const md = '```ts\nconst a = 1;\n```';
    const html = toHtml(md);
    expect(html).toContain('<pre class="qf-codeblock">');
    expect(html).toContain('<span class="qf-codeblock__lang">ts</span>');
    expect(html).toContain('<code>const a = 1;\n</code>');
  });

  it('converts @username to qf-mention span', () => {
    expect(toHtml('hi @designer_kim please review')).toContain(
      '<span class="qf-mention">@designer_kim</span>',
    );
  });

  it('includes dots and hyphens in the mention (matches shared-types [a-zA-Z0-9_.-])', () => {
    // Regression guard from task-018 reviewer HIGH-1: prior regex split
    // `@alice-dev` into `@alice` + `-dev` and `@user.name` into `@user`
    // + `.name`, disagreeing with the server-side mention extractor.
    expect(toHtml('hello @alice-dev')).toContain('<span class="qf-mention">@alice-dev</span>');
    expect(toHtml('cc @user.name please')).toContain('<span class="qf-mention">@user.name</span>');
  });

  it('does not parse inline rules inside fenced blocks', () => {
    const html = toHtml('```\nNo `code` or @mentions here\n```');
    expect(html).not.toContain('qf-code-inline');
    expect(html).not.toContain('qf-mention');
    expect(html).toContain('<code>No `code` or @mentions here\n</code>');
  });

  it('splits newlines into <br>', () => {
    const html = toHtml('line1\nline2');
    expect(html).toBe('line1<br/>line2');
  });

  it('empty content produces no nodes', () => {
    expect(renderMessageContent('')).toEqual([]);
  });

  it('task-037-D: replaces :name: with <img class="qf-emoji-custom"> when known', () => {
    const map = new Map<string, CustomEmoji>([
      [
        'party_parrot',
        {
          id: 'e1',
          name: 'party_parrot',
          createdBy: 'u1',
          createdAt: '2026-04-22T00:00:00Z',
          url: 'https://cdn.example/party.gif',
          urlExpiresAt: '2026-04-22T00:30:00Z',
          sizeBytes: 1024,
          mime: 'image/gif',
        },
      ],
    ]);
    const html = toHtml('hello :party_parrot: world', map);
    expect(html).toContain('class="qf-emoji-custom"');
    expect(html).toContain('src="https://cdn.example/party.gif"');
    expect(html).toContain('alt=":party_parrot:"');
  });

  it('task-037-D: unknown :name: falls through as plain text', () => {
    const html = toHtml('check :missing_emoji: here');
    expect(html).not.toContain('qf-emoji-custom');
    expect(html).toContain(':missing_emoji:');
  });

  // task-044 iteration 1: markdown bold/italic/strike/quote.
  describe('task-044 markdown', () => {
    it('renders **bold** as <strong class="font-semibold">', () => {
      expect(toHtml('say **hello** there')).toContain(
        '<strong class="font-semibold">hello</strong>',
      );
    });

    it('renders *italic* as <em class="italic">', () => {
      expect(toHtml('this is *cool* yo')).toContain('<em class="italic">cool</em>');
    });

    it('renders _italic_ underscore variant as <em class="italic">', () => {
      expect(toHtml('alt _emph_ form')).toContain('<em class="italic">emph</em>');
    });

    it('renders ~~strike~~ as <s class="line-through">', () => {
      expect(toHtml('was ~~old~~ now new')).toContain('<s class="line-through">old</s>');
    });

    it('renders single line `> quote` as <blockquote>', () => {
      const html = toHtml('> a note');
      expect(html).toContain('<blockquote');
      expect(html).toContain('a note');
      expect(html).toContain('border-l-2');
    });

    it('groups consecutive `> quote` lines into one blockquote with <br>', () => {
      const html = toHtml('> line one\n> line two');
      // 한 blockquote 안에 두 줄 (br 로 구분)
      const opens = html.match(/<blockquote/g) ?? [];
      expect(opens.length).toBe(1);
      expect(html).toContain('line one');
      expect(html).toContain('line two');
      expect(html).toContain('<br/>');
    });

    it('separates plain text + quote into independent blocks', () => {
      const html = toHtml('plain\n> note\nback to plain');
      const opens = html.match(/<blockquote/g) ?? [];
      expect(opens.length).toBe(1);
      expect(html).toContain('plain');
      expect(html).toContain('note');
      expect(html).toContain('back to plain');
    });

    it('does not parse markdown inside fenced code', () => {
      const html = toHtml('```\n**no** *no* ~~no~~\n```');
      expect(html).not.toContain('font-semibold');
      expect(html).not.toContain('class="italic"');
      expect(html).not.toContain('line-through');
    });

    it('does not parse markdown inside inline code', () => {
      const html = toHtml('use `**raw**` here');
      expect(html).toContain('<code class="qf-code-inline">**raw**</code>');
      expect(html).not.toContain('font-semibold');
    });

    it('flattens nested italic inside bold (greedy bold pass)', () => {
      // **a *b* c** → bold 만 매칭, 내부 *b* 는 plain
      const html = toHtml('**a *b* c**');
      expect(html).toContain('<strong class="font-semibold">a *b* c</strong>');
    });

    it('preserves @mention next to bold', () => {
      const html = toHtml('hi **bold** @alice');
      expect(html).toContain('<strong class="font-semibold">bold</strong>');
      expect(html).toContain('<span class="qf-mention">@alice</span>');
    });

    it('does not blockquote `>` without trailing space at line start when intermediate', () => {
      // 라인 중간의 `>` 는 quote 아님
      const html = toHtml('a > b');
      expect(html).not.toContain('<blockquote');
      expect(html).toContain('a &gt; b');
    });
  });
});
