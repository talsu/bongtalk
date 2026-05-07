import { describe, expect, it } from 'vitest';
import { markOnlyHtml, highlightSnippet, searchSnippetHtml } from './sanitize';

describe('markOnlyHtml', () => {
  it('keeps <mark> tags intact', () => {
    expect(markOnlyHtml('hello <mark>world</mark>')).toBe('hello <mark>world</mark>');
  });

  it('escapes every other tag', () => {
    const out = markOnlyHtml('<script>alert(1)</script><mark>x</mark>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('&lt;script');
    expect(out).toContain('<mark>x</mark>');
  });

  it('does NOT double-escape server-escaped entities', () => {
    // Server pre-escapes content before ts_headline, so snippets
    // arrive with `&amp;`/`&lt;`/`&gt;` already in place. The
    // sanitizer must leave them alone or the user sees `&amp;amp;`.
    const serverEscaped = 'foo &amp; bar &lt;baz&gt; <mark>hit</mark>';
    expect(markOnlyHtml(serverEscaped)).toBe('foo &amp; bar &lt;baz&gt; <mark>hit</mark>');
  });

  it('keeps literal & outside tags untouched', () => {
    expect(markOnlyHtml('1 & 2 <mark>hit</mark>')).toBe('1 & 2 <mark>hit</mark>');
  });

  it('escapes tags with attributes (no whitelisting by tag name alone)', () => {
    const out = markOnlyHtml('<img src=x onerror=alert(1)> <mark>ok</mark>');
    // img tag should be stripped to text (escaped), mark kept.
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain('&lt;img');
    expect(out).toContain('<mark>ok</mark>');
  });
});

/**
 * task-047 iter1 (J4): mention + inline code 강조.
 */
describe('highlightSnippet (task-047 J4)', () => {
  it('@username 을 qf-mention span 으로 강조', () => {
    expect(highlightSnippet('hello @alice world')).toBe(
      'hello <span class="qf-mention">@alice</span> world',
    );
  });

  it('#channel 을 qf-channel-ref span 으로 강조', () => {
    expect(highlightSnippet('see #general for details')).toBe(
      'see <span class="qf-channel-ref">#general</span> for details',
    );
  });

  it('inline code 를 <code> 로 감쌈', () => {
    expect(highlightSnippet('use `npm install`')).toBe(
      'use <code class="qf-search-code">npm install</code>',
    );
  });

  it('username 의 일부인 @ 는 매칭 안 함 (boundary 확인)', () => {
    // foo@bar.com 의 @ 는 단어 경계 뒤가 아님 — boundary 룰 검증
    expect(highlightSnippet('contact foo@example')).toBe('contact foo@example');
  });

  it('mark 와 함께 사용 시 mark 가 보존됨', () => {
    const input = 'hello <mark>world</mark> @alice';
    const out = highlightSnippet(input);
    expect(out).toContain('<mark>world</mark>');
    expect(out).toContain('<span class="qf-mention">@alice</span>');
  });

  it('mention / channel / code 동시 등장', () => {
    const input = '@alice see #general for `code`';
    const out = highlightSnippet(input);
    expect(out).toContain('<span class="qf-mention">@alice</span>');
    expect(out).toContain('<span class="qf-channel-ref">#general</span>');
    expect(out).toContain('<code class="qf-search-code">code</code>');
  });
});

describe('searchSnippetHtml (task-047 J4 통합)', () => {
  it('markOnlyHtml + highlightSnippet 체이닝', () => {
    const input = '<script>x</script>hello <mark>found</mark> @alice';
    const out = searchSnippetHtml(input);
    // script 는 escape, mark 는 유지, mention 은 강조
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('&lt;script');
    expect(out).toContain('<mark>found</mark>');
    expect(out).toContain('<span class="qf-mention">@alice</span>');
  });
});
