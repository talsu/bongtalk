import { describe, it, expect } from 'vitest';
import { parseOgMetadata } from '../../../src/links/og-parser';

describe('parseOgMetadata', () => {
  it('og:* 가 모두 있으면 그대로 추출', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Hello"/>
        <meta property="og:description" content="World"/>
        <meta property="og:image" content="https://x.test/i.png"/>
        <meta property="og:site_name" content="X"/>
        <meta property="og:url" content="https://x.test/page"/>
      </head><body></body></html>
    `;
    expect(parseOgMetadata(html)).toEqual({
      title: 'Hello',
      description: 'World',
      image: 'https://x.test/i.png',
      siteName: 'X',
      canonical: 'https://x.test/page',
    });
  });

  it('og:* 부재 시 fallback (<title>, meta description, twitter:image, link rel=canonical)', () => {
    const html = `
      <html><head>
        <title>FallTitle</title>
        <meta name="description" content="FallDesc"/>
        <meta name="twitter:image" content="https://x.test/t.png"/>
        <link rel="canonical" href="https://x.test/canon"/>
      </head><body></body></html>
    `;
    expect(parseOgMetadata(html)).toEqual({
      title: 'FallTitle',
      description: 'FallDesc',
      image: 'https://x.test/t.png',
      siteName: null,
      canonical: 'https://x.test/canon',
    });
  });

  it('og:title 이 우선, <title> 은 fallback', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="OG"/>
        <title>HTMLTitle</title>
      </head></html>
    `;
    expect(parseOgMetadata(html).title).toBe('OG');
  });

  it('빈 HTML / 메타 없으면 모두 null', () => {
    const html = '<html><head></head><body>hi</body></html>';
    expect(parseOgMetadata(html)).toEqual({
      title: null,
      description: null,
      image: null,
      siteName: null,
      canonical: null,
    });
  });

  it('비-HTML / 손상된 입력은 안전하게 null 반환', () => {
    expect(parseOgMetadata('')).toEqual({
      title: null,
      description: null,
      image: null,
      siteName: null,
      canonical: null,
    });
    expect(parseOgMetadata('<<not html>>')).toEqual({
      title: null,
      description: null,
      image: null,
      siteName: null,
      canonical: null,
    });
  });

  it('whitespace 는 trim', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="  Padded  "/>
      </head></html>
    `;
    expect(parseOgMetadata(html).title).toBe('Padded');
  });
});
