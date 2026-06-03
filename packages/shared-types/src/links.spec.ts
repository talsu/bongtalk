import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  extractUnfurlUrls,
  LINK_UNFURL_CAP_PER_MESSAGE,
  MessageEmbedDtoSchema,
} from './links';
import { WS_EVENTS, WS_EVENT_PAYLOAD_SCHEMAS, MessageEmbedUpdatedPayloadSchema } from './events';

describe('S60 normalizeUrl (FR-RC07)', () => {
  it('lowercases scheme + host but preserves path/query case', () => {
    expect(normalizeUrl('HTTP://Example.COM/Path?A=B')).toBe('http://example.com/Path?A=B');
  });

  it('removes utm_* tracking params', () => {
    expect(normalizeUrl('https://x.com/p?utm_source=a&utm_medium=b&keep=1')).toBe(
      'https://x.com/p?keep=1',
    );
  });

  it('removes fbclid and gclid', () => {
    expect(normalizeUrl('https://x.com/p?fbclid=abc&gclid=def&q=1')).toBe('https://x.com/p?q=1');
  });

  it('drops the query entirely when only tracking params remain', () => {
    expect(normalizeUrl('https://x.com/p?utm_source=a')).toBe('https://x.com/p');
  });

  it('removes trailing slash but keeps root slash', () => {
    expect(normalizeUrl('https://x.com/path/')).toBe('https://x.com/path');
    expect(normalizeUrl('https://x.com/')).toBe('https://x.com/');
  });

  it('removes the URL fragment', () => {
    expect(normalizeUrl('https://x.com/p#section')).toBe('https://x.com/p');
  });

  it('strips default ports but keeps non-default ports', () => {
    expect(normalizeUrl('http://x.com:80/p')).toBe('http://x.com/p');
    expect(normalizeUrl('https://x.com:443/p')).toBe('https://x.com/p');
    expect(normalizeUrl('https://x.com:8443/p')).toBe('https://x.com:8443/p');
  });

  it('strips userinfo for cache-key stability', () => {
    expect(normalizeUrl('https://user:pass@x.com/p')).toBe('https://x.com/p');
  });

  it('returns the trimmed input for non-http(s) or unparseable URLs', () => {
    expect(normalizeUrl('  ftp://x.com/p  ')).toBe('ftp://x.com/p');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });

  it('is idempotent (normalize(normalize(x)) === normalize(x))', () => {
    const once = normalizeUrl('HTTPS://X.com/A/?utm_source=z#frag');
    expect(normalizeUrl(once)).toBe(once);
  });
});

describe('S60 extractUnfurlUrls (FR-RC07/08 · FR-AM-16)', () => {
  it('extracts http(s) URLs from plain text', () => {
    expect(extractUnfurlUrls('see https://a.com and http://b.com')).toEqual([
      'https://a.com',
      'http://b.com',
    ]);
  });

  it('skips angle-bracket wrapped URLs (<url> suppress)', () => {
    expect(extractUnfurlUrls('escaped <https://a.com> only')).toEqual([]);
  });

  it('skips URLs inside fenced code blocks', () => {
    expect(extractUnfurlUrls('```\nhttps://a.com\n```')).toEqual([]);
  });

  it('skips URLs inside inline code', () => {
    expect(extractUnfurlUrls('inline `https://a.com` code')).toEqual([]);
  });

  it('strips trailing punctuation from the matched URL', () => {
    expect(extractUnfurlUrls('go to https://a.com.')).toEqual(['https://a.com']);
  });

  it('caps at LINK_UNFURL_CAP_PER_MESSAGE and dedupes', () => {
    const content = 'https://a.com https://b.com https://c.com https://d.com https://a.com';
    const out = extractUnfurlUrls(content);
    expect(out.length).toBe(LINK_UNFURL_CAP_PER_MESSAGE);
    expect(out).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('returns [] for empty content', () => {
    expect(extractUnfurlUrls('')).toEqual([]);
  });
});

describe('S60 MessageEmbedDtoSchema (contract)', () => {
  it('accepts a full embed with proxy image url', () => {
    const parsed = MessageEmbedDtoSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      url: 'https://a.com',
      title: 'Title',
      description: 'Desc',
      siteName: 'A',
      imageProxyUrl: '/links/embed-image/22222222-2222-2222-2222-222222222222',
      suppressedAt: null,
    });
    expect(parsed.imageProxyUrl).toContain('/links/embed-image/');
  });

  it('defaults nullable fields when omitted (forward-compat)', () => {
    const parsed = MessageEmbedDtoSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      url: 'https://a.com',
    });
    expect(parsed.title).toBeNull();
    expect(parsed.imageProxyUrl).toBeNull();
    expect(parsed.suppressedAt).toBeNull();
  });
});

describe('S60 MESSAGE_EMBED_UPDATED (WS contract)', () => {
  it('registers the wire event name', () => {
    expect(WS_EVENTS.MESSAGE_EMBED_UPDATED).toBe('message:embed_updated');
  });

  it('has a payload schema entry', () => {
    expect(WS_EVENT_PAYLOAD_SCHEMAS[WS_EVENTS.MESSAGE_EMBED_UPDATED]).toBe(
      MessageEmbedUpdatedPayloadSchema,
    );
  });

  it('validates a payload with embeds[]', () => {
    const parsed = MessageEmbedUpdatedPayloadSchema.parse({
      channelId: '33333333-3333-3333-3333-333333333333',
      messageId: '44444444-4444-4444-4444-444444444444',
      embeds: [{ id: '55555555-5555-5555-5555-555555555555', url: 'https://a.com' }],
    });
    expect(parsed.embeds.length).toBe(1);
    expect(parsed.embeds[0].title).toBeNull();
  });
});
