import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMessageContent } from './parseContent';

function toHtml(input: string): string {
  const nodes = renderMessageContent(input);
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
});
