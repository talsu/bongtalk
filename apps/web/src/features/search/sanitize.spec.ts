import { describe, expect, it } from 'vitest';
import { markOnlyHtml } from './sanitize';

describe('markOnlyHtml', () => {
  it('keeps <mark> tags intact', () => {
    expect(markOnlyHtml('hello <mark>world</mark>')).toBe('hello <mark>world</mark>');
  });

  it('escapes every other tag', () => {
    const out = markOnlyHtml('<script>alert(1)</script><mark>x</mark>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<mark>x</mark>');
  });

  it('handles server-double-escaped input (defense-in-depth)', () => {
    // If the server accidentally double-escaped, the second
    // replacement pass catches the &amp;lt;mark&amp;gt; shape.
    const out = markOnlyHtml('foo &lt;mark&gt;bar&lt;/mark&gt; baz');
    expect(out).toContain('<mark>bar</mark>');
  });

  it('escapes standalone angle brackets outside mark', () => {
    expect(markOnlyHtml('1 < 2 and 3 > 2')).toBe('1 &lt; 2 and 3 &gt; 2');
  });
});
