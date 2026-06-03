import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageEmbedDto } from '@qufox/shared-types';
import { LinkPreview } from './LinkPreview';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function embed(over: Partial<MessageEmbedDto> = {}): MessageEmbedDto {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    url: 'https://example.com',
    title: 'Example Title',
    description: 'Example description',
    siteName: 'Example',
    imageProxyUrl: null,
    suppressedAt: null,
    ...over,
  };
}

describe('S60 LinkPreview — server embed mode (FR-RC07/21)', () => {
  it('renders a card from a server-pushed embed', () => {
    const html = renderToStaticMarkup(<LinkPreview embed={embed()} />);
    expect(html).toContain('qf-embed');
    expect(html).toContain('Example Title');
    expect(html).toContain('Example description');
  });

  it('renders the image via the backend proxy path (never a presigned URL)', () => {
    const html = renderToStaticMarkup(
      <LinkPreview
        embed={embed({ imageProxyUrl: '/links/embed-image/55555555-5555-5555-5555-555555555555' })}
      />,
    );
    expect(html).toContain('src="/links/embed-image/55555555-5555-5555-5555-555555555555"');
    // presigned/외부 URL 직접 노출 안 됨.
    expect(html).not.toContain('http://');
    expect(html).not.toContain('X-Amz');
  });

  it('hides a suppressed embed (suppressedAt set → null render)', () => {
    const html = renderToStaticMarkup(
      <LinkPreview embed={embed({ suppressedAt: '2025-01-01T00:00:00.000Z' })} />,
    );
    expect(html).toBe('');
  });

  it('renders nothing when title/description/image are all empty', () => {
    const html = renderToStaticMarkup(
      <LinkPreview embed={embed({ title: null, description: null, imageProxyUrl: null })} />,
    );
    expect(html).toBe('');
  });

  it('downgrades an unsafe-scheme title to non-link text (XSS surface closed)', () => {
    const html = renderToStaticMarkup(
      <LinkPreview embed={embed({ url: 'javascript:alert(1)' })} />,
    );
    // 제목은 보이되 href 앵커는 없어야 한다.
    expect(html).toContain('Example Title');
    expect(html).not.toContain('href="javascript');
  });
});
