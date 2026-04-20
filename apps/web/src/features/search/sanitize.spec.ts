import { describe, expect, it } from 'vitest';
import { markOnlyHtml } from './sanitize';

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
