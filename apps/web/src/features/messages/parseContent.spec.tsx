import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  renderMessageContent,
  extractMessageUrls,
  LINK_PREVIEW_CAP_PER_MESSAGE,
} from './parseContent';
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

  // task-045 iter6: extractMessageUrls — link unfurl 카드를 위한 URL 추출.
  describe('task-045 extractMessageUrls', () => {
    it('빈 입력 → 빈 배열', () => {
      expect(extractMessageUrls('')).toEqual([]);
    });

    it('단일 URL 추출', () => {
      const out = extractMessageUrls('hi https://example.com bye');
      expect(out).toEqual(['https://example.com']);
    });

    it('http(s) 외 scheme 무시', () => {
      const out = extractMessageUrls('check ftp://example.com or file:///etc/passwd');
      expect(out).toEqual([]);
    });

    it('중복 URL 은 한 번만', () => {
      const out = extractMessageUrls('a https://x.test b https://x.test c');
      expect(out).toEqual(['https://x.test']);
    });

    it(`최대 ${LINK_PREVIEW_CAP_PER_MESSAGE} 개까지`, () => {
      const out = extractMessageUrls(
        'https://a.test https://b.test https://c.test https://d.test https://e.test',
      );
      expect(out).toHaveLength(LINK_PREVIEW_CAP_PER_MESSAGE);
      expect(out).toEqual(['https://a.test', 'https://b.test', 'https://c.test']);
    });

    it('fenced code 안의 URL 무시', () => {
      const out = extractMessageUrls('see ```\nhttps://hidden.test\n``` then https://shown.test');
      expect(out).toEqual(['https://shown.test']);
    });

    it('inline code 안의 URL 무시', () => {
      const out = extractMessageUrls('use `https://hidden.test` then https://shown.test');
      expect(out).toEqual(['https://shown.test']);
    });

    it('quote 라인 안의 URL 도 추출 (전체 텍스트로 인식)', () => {
      // quote prefix 만 stripping — quote body 의 URL 은 일반 메시지와 동일.
      const out = extractMessageUrls('> note: https://shown.test\nthen https://other.test');
      expect(out).toEqual(['https://shown.test', 'https://other.test']);
    });

    it('trailing punct 보호 — 마침표 swallow 안 함', () => {
      const out = extractMessageUrls('see https://example.com.');
      expect(out).toEqual(['https://example.com']);
    });

    // S02 보안(리뷰 HIGH): contentAst 유무와 무관하게 항상 msg.content 로
    // 호출되므로 FENCE_RE lazy-quantifier 백트래킹 worst-case 를 막기 위해
    // MAX_PLAIN_LENGTH(4,000자) 로 입력을 먼저 자른다. 4,000자 경계 너머의
    // URL 은 추출되지 않아야 한다(렌더 경로의 bounded 와 동일 계약).
    it('4,000자 초과 입력은 잘려 경계 밖 URL 미추출', () => {
      const padding = 'x'.repeat(4000);
      const out = extractMessageUrls(`${padding} https://past-bound.test`);
      expect(out).toEqual([]);
    });

    it('4,000자 경계 안의 URL 은 정상 추출', () => {
      const out = extractMessageUrls(`https://within-bound.test ${'x'.repeat(3000)}`);
      expect(out).toEqual(['https://within-bound.test']);
    });
  });
});
