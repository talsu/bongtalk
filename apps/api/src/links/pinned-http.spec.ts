import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage as NodeIncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import { pinnedRequest, readBoundedBuffer } from './pinned-http';

// S60 fix (security BLOCKER-1 / HIGH-3): IP 핀 HTTP 공통 모듈 단위 테스트.
//
// pinnedRequest / followPinnedRedirects 의 핵심 보장:
//   - 검증된 IP 로 직접 connect 하되 Host 헤더는 원래 hostname 으로 보낸다(IP 핀).
//   - followPinnedRedirects 는 각 hop 마다 ssrfGuard 를 재검증한다(rebind hop 차단).
// readBoundedBuffer:
//   - maxBytes 상한에서 잘라 끊고, `end` 없이 `close` 만 오면 null 을 돌려준다.
//
// 실 소켓은 127.0.0.1 로컬 서버로 띄우되, ssrfGuard 를 우회하는 pinnedRequest 직접 호출로
// 검증한다(ssrfGuard 의 loopback reject 는 ssrf-guard.spec 이 별도 검증).

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function readBody(res: NodeIncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve(body));
  });
}

describe('pinnedRequest — IP 핀 connect + Host 헤더 보존', () => {
  it('connects to the pinned IP and sends the original hostname in the Host header', async () => {
    let observedHost: string | undefined;
    const server = createServer((req, res) => {
      observedHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const port = await listen(server);
    try {
      // url.hostname = victim.example.com 이지만 실제 connect 는 검증된 127.0.0.1 로 핀.
      const url = new URL(`http://victim.example.com:${port}/path?x=1`);
      const res = await pinnedRequest({
        url,
        ip: '127.0.0.1',
        family: 4,
        timeoutMs: 2000,
        headers: { 'user-agent': 'test-agent', accept: 'text/html' },
      });
      const body = await readBody(res);
      expect(res.statusCode).toBe(200);
      expect(body).toBe('ok');
      // Host 헤더는 원래 hostname(포트 포함) — connect IP 가 아니다.
      expect(observedHost).toBe(`victim.example.com:${port}`);
    } finally {
      server.close();
    }
  });

  it('rejects when the AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const url = new URL('http://example.com/');
    await expect(
      pinnedRequest({
        url,
        ip: '127.0.0.1',
        family: 4,
        timeoutMs: 2000,
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('readBoundedBuffer — 상한 절단 + close-without-end', () => {
  it('truncates the body at maxBytes', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // 10 bytes 전송, 상한 4 bytes.
      res.end(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest({
        url: new URL(`http://h.example.com:${port}/`),
        ip: '127.0.0.1',
        family: 4,
        timeoutMs: 2000,
        headers: {},
      });
      const buf = await readBoundedBuffer(res, 4);
      expect(buf).not.toBeNull();
      expect(buf?.byteLength).toBe(4);
      expect([...(buf ?? Buffer.alloc(0))]).toEqual([1, 2, 3, 4]);
    } finally {
      server.close();
    }
  });

  it('returns the full body when under the limit', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('hello');
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest({
        url: new URL(`http://h.example.com:${port}/`),
        ip: '127.0.0.1',
        family: 4,
        timeoutMs: 2000,
        headers: {},
      });
      const buf = await readBoundedBuffer(res, 1024);
      expect(buf?.toString('utf-8')).toBe('hello');
    } finally {
      server.close();
    }
  });

  it('returns null when the stream closes without `end` (partial response not trusted)', async () => {
    // 실 소켓 destroy 는 request 에러와 경합하므로, IncomingMessage 의 이벤트 계약만
    // 합성 EventEmitter 로 검증한다: `data`(부분) → `close`(end 없음) → null.
    const fake = new EventEmitter() as unknown as NodeIncomingMessage;
    const p = readBoundedBuffer(fake, 1024);
    fake.emit('data', Buffer.from('partial'));
    fake.emit('close');
    await expect(p).resolves.toBeNull();
  });

  it('returns the buffer when `end` precedes `close` (normal completion)', async () => {
    const fake = new EventEmitter() as unknown as NodeIncomingMessage;
    const p = readBoundedBuffer(fake, 1024);
    fake.emit('data', Buffer.from('done'));
    fake.emit('end');
    fake.emit('close');
    await expect(p).resolves.toEqual(Buffer.from('done'));
  });
});

describe('followPinnedRedirects — 각 hop ssrfGuard 재검증(rebind hop 차단)', () => {
  it('re-validates each redirect hop and throws when a hop is SSRF-rejected (rebind block)', async () => {
    // hop1 = public(ok), hop2(redirect 대상) = 검증 시점에 private 으로 rebind → reject.
    vi.resetModules();
    vi.doMock('./ssrf-guard', () => ({
      ssrfGuard: vi.fn(async (raw: string) => {
        const u = new URL(raw);
        if (u.hostname === 'rebind.example.com') {
          // rebinding: 검증 시점에 사설 IP 로 해석 → reject.
          return { ok: false as const, reason: 'private_ip' as const };
        }
        return {
          ok: true as const,
          resolvedIp: '127.0.0.1',
          family: 4 as const,
          url: u,
        };
      }),
    }));
    const mod = await import('./pinned-http');

    let port = 0;
    const server = createServer((_req, res) => {
      // 첫 hop 은 rebind.example.com 으로 302 redirect.
      res.writeHead(302, { location: `http://rebind.example.com:${port}/internal` });
      res.end();
    });
    port = await listen(server);
    try {
      await expect(
        mod.followPinnedRedirects({
          startUrl: `http://public.example.com:${port}/`,
          maxRedirects: 5,
          timeoutMs: 2000,
          headers: {},
        }),
      ).rejects.toThrow(/ssrf-guard rejected redirect target/);
    } finally {
      server.close();
    }
  });

  it('follows a redirect to a still-public hop and returns the final response', async () => {
    vi.resetModules();
    vi.doMock('./ssrf-guard', () => ({
      ssrfGuard: vi.fn(async (raw: string) => ({
        ok: true as const,
        resolvedIp: '127.0.0.1',
        family: 4 as const,
        url: new URL(raw),
      })),
    }));
    const mod = await import('./pinned-http');

    let port = 0;
    const server = createServer((req, res) => {
      if (req.url === '/final') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Final</title></head></html>');
        return;
      }
      res.writeHead(301, { location: `http://hop.example.com:${port}/final` });
      res.end();
    });
    port = await listen(server);
    try {
      const out = await mod.followPinnedRedirects({
        startUrl: `http://start.example.com:${port}/start`,
        maxRedirects: 5,
        timeoutMs: 2000,
        headers: {},
      });
      expect(out.res.statusCode).toBe(200);
      expect(out.finalUrl).toBe(`http://hop.example.com:${port}/final`);
      const buf = await mod.readBoundedBuffer(out.res, 65536);
      expect(buf?.toString('utf-8')).toContain('Final');
    } finally {
      server.close();
    }
  });
});
