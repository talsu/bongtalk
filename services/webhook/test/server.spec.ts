import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/audit';
import { noopNotifier } from '../src/notify';
import { DeployQueue, type DeployJob, type Outcome } from '../src/queue';
import { createWebhookServer } from '../src/server';

const SECRET = 'unit-test-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

interface Deps {
  queue: DeployQueue;
  audit: AuditLog;
  submitted: DeployJob[];
  auditPath: string;
}

async function setup(
  runner: (job: DeployJob) => Promise<Outcome> = async () => 'ok',
): Promise<Deps & { close: () => Promise<void>; url: (p: string) => string; port: number }> {
  const tmp = await mkdtemp(join(tmpdir(), 'qufox-webhook-'));
  const auditPath = join(tmp, 'audit.jsonl');
  const audit = new AuditLog(auditPath);
  const submitted: DeployJob[] = [];
  const queue = new DeployQueue(async (j) => {
    submitted.push(j);
    return runner(j);
  });
  const server = createWebhookServer({
    secret: SECRET,
    branchAllowlist: ['main'],
    queue,
    audit,
    notifier: noopNotifier,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const port = addr.port;
  return {
    queue,
    audit,
    submitted,
    auditPath,
    port,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

function pushBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    after: 'abcdef0123456789abcdef0123456789abcdef01',
    pusher: { name: 'alice' },
    ...overrides,
  });
}

describe('webhook server', () => {
  let ctx: Awaited<ReturnType<typeof setup>> | null = null;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
  });

  it('GET /healthz returns 200', async () => {
    const res = await fetch(ctx!.url('/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('unknown path returns 404', async () => {
    const res = await fetch(ctx!.url('/nope'));
    expect(res.status).toBe(404);
  });

  it('POST without signature returns 401', async () => {
    const body = pushBody();
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: { 'x-github-event': 'push' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('POST with bad signature returns 401', async () => {
    const body = pushBody();
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=' + 'f'.repeat(64),
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('ping event returns 200 without enqueuing', async () => {
    const body = '{}';
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
    expect(ctx!.submitted).toHaveLength(0);
  });

  it('unsupported event is ACK+ignored', async () => {
    const body = '{}';
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
  });

  it('branch not in allowlist is ACK+ignored', async () => {
    const body = pushBody({ ref: 'refs/heads/develop' });
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(ctx!.submitted).toHaveLength(0);
  });

  it('valid push on main is accepted and enqueued', async () => {
    const body = pushBody();
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(ctx!.submitted).toHaveLength(1));
    expect(ctx!.submitted[0]).toMatchObject({
      sha: 'abcdef0123456789abcdef0123456789abcdef01',
      branch: 'main',
      pusher: 'alice',
    });
  });

  it('branch delete push is ACK+ignored', async () => {
    const body = pushBody({ deleted: true });
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(ctx!.submitted).toHaveLength(0);
  });

  it('malformed JSON returns 400', async () => {
    const body = 'not-json';
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('missing ref is rejected', async () => {
    const body = JSON.stringify({ after: 'x'.repeat(40), pusher: { name: 'alice' } });
    const res = await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('appends an audit line per request', async () => {
    const body = pushBody();
    await fetch(ctx!.url('/hooks/github'), {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    await vi.waitFor(async () => {
      const contents = await readFile(ctx!.auditPath, 'utf8').catch(() => '');
      expect(contents).toContain('"event":"deploy.enqueue"');
    });
  });
});
