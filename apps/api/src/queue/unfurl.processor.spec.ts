import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';

// S60: 워커 단위테스트는 실제 DNS/네트워크에 의존하지 않도록 ssrfGuard 를 mock 한다
// (vi.fn 만 사용). 기본은 public 허용(ok:true) — SSRF reject 케이스는 ssrf-guard 자체
// 단위테스트(og-image-fetcher.spec)에서 검증한다.
vi.mock('../links/ssrf-guard', () => ({
  ssrfGuard: vi.fn(async (url: string) => ({
    ok: true as const,
    resolvedIp: '93.184.216.34',
    family: 4 as const,
    url: new URL(url),
  })),
}));

import { UnfurlProcessor } from './unfurl.processor';
import type { UnfurlJobData } from './unfurl-queue.constants';
import type { PrismaService } from '../prisma/prisma.module';
import type { OutboxService } from '../common/outbox/outbox.service';
import type { LinksService, LinkPreview } from '../links/links.service';
import type { OgImageFetcher } from '../links/og-image-fetcher';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function preview(over: Partial<LinkPreview> = {}): LinkPreview {
  return {
    url: 'https://a.com',
    title: 'Title',
    description: 'Desc',
    image: null,
    siteName: 'A',
    statusCode: 200,
    fetchedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

interface Mocks {
  prisma: PrismaService;
  outbox: OutboxService;
  links: LinksService;
  ogImage: OgImageFetcher;
  upsert: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  fetchAndParse: ReturnType<typeof vi.fn>;
  getCachedByKey: ReturnType<typeof vi.fn>;
  fetchAndStore: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
}

function makeMocks(
  opts: {
    messageDeleted?: boolean;
    messageMissing?: boolean;
    cached?: LinkPreview | null;
    fetched?: LinkPreview;
  } = {},
): Mocks {
  const upsert = vi.fn(async () => ({ id: 'embed-1' }));
  const findMany = vi.fn(async () => [
    {
      id: 'embed-1',
      url: 'https://a.com',
      title: 'Title',
      description: 'Desc',
      siteName: 'A',
      imageKey: null,
      suppressedAt: null,
    },
  ]);
  const findUnique = vi.fn(async () =>
    opts.messageMissing
      ? null
      : { id: 'msg-1', deletedAt: opts.messageDeleted ? new Date() : null, channelId: 'chan-1' },
  );
  const prisma = {
    message: { findUnique },
    messageEmbed: { upsert, findMany },
  } as unknown as PrismaService;

  const record = vi.fn(async () => 'outbox-1');
  const outbox = { record } as unknown as OutboxService;

  const fetchAndParse = vi.fn(async () => opts.fetched ?? preview());
  const getCachedByKey = vi.fn(async () => opts.cached ?? null);
  const cachePreview = vi.fn(async () => undefined);
  const embedCacheKey = vi.fn((u: string) => `key-${u}`);
  const links = {
    fetchAndParse,
    getCachedByKey,
    cachePreview,
    embedCacheKey,
  } as unknown as LinksService;

  const fetchAndStore = vi.fn(async () => ({
    imageKey: 'link-embeds/x.png',
    mime: 'image/png',
    sizeBytes: 3,
  }));
  const ogImage = { fetchAndStore } as unknown as OgImageFetcher;

  return {
    prisma,
    outbox,
    links,
    ogImage,
    upsert,
    record,
    fetchAndParse,
    getCachedByKey,
    fetchAndStore,
    findMany,
  };
}

function job(data: UnfurlJobData): Job<UnfurlJobData> {
  return { data } as Job<UnfurlJobData>;
}

const baseJob: UnfurlJobData = {
  messageId: 'msg-1',
  channelId: 'chan-1',
  workspaceId: 'ws-1',
  urls: ['https://a.com'],
};

describe('S60 UnfurlProcessor (FR-AM-13 · FR-RC07/09)', () => {
  it('upserts an embed and emits message.embed.updated for a fresh URL', async () => {
    const m = makeMocks();
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job(baseJob));
    expect(m.fetchAndParse).toHaveBeenCalledOnce();
    expect(m.upsert).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledOnce();
    const recordArg = m.record.mock.calls[0][1];
    expect(recordArg.eventType).toBe('message.embed.updated');
    expect(recordArg.payload.channelId).toBe('chan-1');
    expect(recordArg.payload.messageId).toBe('msg-1');
  });

  it('skips entirely when the message is soft-deleted', async () => {
    const m = makeMocks({ messageDeleted: true });
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job(baseJob));
    expect(m.fetchAndParse).not.toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('skips when the message no longer exists', async () => {
    const m = makeMocks({ messageMissing: true });
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job(baseJob));
    expect(m.fetchAndParse).not.toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('uses the Redis cache and skips fetch on a cache hit (FR-RC09)', async () => {
    const m = makeMocks({ cached: preview() });
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job(baseJob));
    expect(m.getCachedByKey).toHaveBeenCalledOnce();
    expect(m.fetchAndParse).not.toHaveBeenCalled();
    expect(m.upsert).toHaveBeenCalledOnce();
  });

  it('does not create a card for non-2xx or empty metadata', async () => {
    const m = makeMocks({
      fetched: preview({ statusCode: 404, title: null, description: null, image: null }),
    });
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job(baseJob));
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('fetches + stores the OG image via OgImageFetcher when present', async () => {
    const m = makeMocks({ fetched: preview({ image: 'https://cdn.a.com/og.png' }) });
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job(baseJob));
    expect(m.fetchAndStore).toHaveBeenCalledWith('https://cdn.a.com/og.png');
    const upsertArg = m.upsert.mock.calls[0][0];
    expect(upsertArg.create.imageKey).toBe('link-embeds/x.png');
  });

  it('is a no-op for an empty url list', async () => {
    const m = makeMocks();
    const p = new UnfurlProcessor(m.prisma, m.outbox, m.links, m.ogImage);
    await p.process(job({ ...baseJob, urls: [] }));
    expect(m.fetchAndParse).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });
});
