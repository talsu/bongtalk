import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeBlock } from './CodeBlock';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function html(code: string, lang?: string | null): string {
  return renderToStaticMarkup(<CodeBlock code={code} lang={lang} />);
}

describe('CodeBlock — syntax highlight (FR-MSG-02 / FR-RC13)', () => {
  it('applies highlight.js token spans for a supported language', () => {
    const out = html('const x = 1;', 'javascript');
    expect(out).toContain('data-highlighted="true"');
    // highlight.js emits hljs-* token classes for JS keywords.
    expect(out).toContain('hljs-keyword');
  });

  it('resolves common aliases (ts → typescript, py → python)', () => {
    expect(html('const x: number = 1;', 'ts')).toContain('data-highlighted="true"');
    expect(html('def f():\n    return 1', 'py')).toContain('data-highlighted="true"');
  });

  it('falls back to plain for an unsupported language but keeps the lang label', () => {
    const out = html('SOME WEIRD ¬code', 'brainfuck');
    expect(out).toContain('data-highlighted="false"');
    expect(out).toContain('qf-codeblock__lang');
    expect(out).toContain('brainfuck');
  });

  it('falls back to plain when no language is specified', () => {
    const out = html('just some text');
    expect(out).toContain('data-highlighted="false"');
    expect(out).not.toContain('qf-codeblock__lang');
    expect(out).toContain('just some text');
  });

  it('does not leak raw HTML on the plain path (XSS — FR-MSG-20)', () => {
    const out = html('<script>alert(1)</script>');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes HTML even on the highlighted path', () => {
    const out = html('const s = "<script>alert(1)</script>";', 'javascript');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('always uses the DS .qf-codeblock class', () => {
    expect(html('x', 'javascript')).toContain('qf-codeblock');
  });
});
