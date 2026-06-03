import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OgImageFetcher } from './og-image-fetcher';
import * as ssrf from './ssrf-guard';
import type { S3Service } from '../storage/s3.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  vi.restoreAllMocks();
});

/** S60: 테스트는 외부 네트워크 I/O(`fetchImageBytes`)를 서브클래스로 stub 한다. */
class TestFetcher extends OgImageFetcher {
  public stubBytes: { bytes: Uint8Array; mime: string } | null = null;
  protected override async fetchImageBytes(): Promise<{ bytes: Uint8Array; mime: string } | null> {
    return this.stubBytes;
  }
}

function makeS3(): { svc: S3Service; putObject: ReturnType<typeof vi.fn> } {
  const putObject = vi.fn(async () => undefined);
  const svc = { putObject } as unknown as S3Service;
  return { svc, putObject };
}

describe('S60 OgImageFetcher.fetchAndStore (FR-AM-14/15)', () => {
  it('stores a valid image/* and returns a link-embeds key', async () => {
    const { svc, putObject } = makeS3();
    const f = new TestFetcher(svc);
    f.stubBytes = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' };
    const out = await f.fetchAndStore('https://cdn.example.com/og.png');
    expect(out).not.toBeNull();
    expect(out?.imageKey.startsWith('link-embeds/')).toBe(true);
    expect(out?.imageKey.endsWith('.png')).toBe(true);
    expect(out?.mime).toBe('image/png');
    expect(putObject).toHaveBeenCalledOnce();
  });

  it('rejects non-image MIME (no MinIO write)', async () => {
    const { svc, putObject } = makeS3();
    const f = new TestFetcher(svc);
    f.stubBytes = { bytes: new Uint8Array([1]), mime: 'text/html' };
    const out = await f.fetchAndStore('https://x.com/page');
    expect(out).toBeNull();
    expect(putObject).not.toHaveBeenCalled();
  });

  it('rejects image/svg+xml (stored-XSS surface — not in allowlist)', async () => {
    const { svc, putObject } = makeS3();
    const f = new TestFetcher(svc);
    f.stubBytes = { bytes: new Uint8Array([1]), mime: 'image/svg+xml' };
    const out = await f.fetchAndStore('https://x.com/evil.svg');
    expect(out).toBeNull();
    expect(putObject).not.toHaveBeenCalled();
  });

  it('returns null when the fetch yields no bytes (SSRF reject / network error path)', async () => {
    const { svc, putObject } = makeS3();
    const f = new TestFetcher(svc);
    f.stubBytes = null;
    const out = await f.fetchAndStore('http://169.254.169.254/latest/meta-data/');
    expect(out).toBeNull();
    expect(putObject).not.toHaveBeenCalled();
  });

  it('returns null (no throw) when MinIO put fails — graceful degrade', async () => {
    const putObject = vi.fn(async () => {
      throw new Error('minio down');
    });
    const svc = { putObject } as unknown as S3Service;
    const f = new TestFetcher(svc);
    f.stubBytes = { bytes: new Uint8Array([1]), mime: 'image/jpeg' };
    const out = await f.fetchAndStore('https://x.com/og.jpg');
    expect(out).toBeNull();
  });
});

describe('S60 ssrf-guard rejects metadata + private targets (FR-AM-14 carryover)', () => {
  it('rejects the cloud metadata IP', async () => {
    const r = await ssrf.ssrfGuard('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
  });

  it('rejects loopback', async () => {
    const r = await ssrf.ssrfGuard('http://127.0.0.1/');
    expect(r.ok).toBe(false);
  });

  it('rejects RFC1918 private', async () => {
    const r = await ssrf.ssrfGuard('http://10.0.0.5/');
    expect(r.ok).toBe(false);
    const r2 = await ssrf.ssrfGuard('http://192.168.1.1/');
    expect(r2.ok).toBe(false);
  });
});
