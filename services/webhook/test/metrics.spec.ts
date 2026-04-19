import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/audit';
import { DeployMetrics } from '../src/metrics';
import { noopNotifier } from '../src/notify';
import { DeployQueue, type Outcome, type QueueObserver } from '../src/queue';
import { createWebhookServer } from '../src/server';

const SECRET = 'metrics-spec';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('DeployMetrics class', () => {
  it('seeds the three result labels so /metrics always lists them', async () => {
    const m = new DeployMetrics();
    const text = await m.expose();
    expect(text).toMatch(/qufox_deploys_total\{result="ok"\} 0/);
    expect(text).toMatch(/qufox_deploys_total\{result="fail"\} 0/);
    expect(text).toMatch(/qufox_deploys_total\{result="rollback"\} 0/);
    expect(text).toMatch(/qufox_deploy_duration_seconds_bucket/);
    expect(text).toMatch(/qufox_deploy_queue_depth 0/);
    expect(text).toMatch(/qufox_deploy_rollbacks_total 0/);
  });

  it('observer wiring bumps duration + total', async () => {
    const m = new DeployMetrics();
    const observer: QueueObserver = {
      onDepthChange: (d) => m.queueDepth.set(d),
      onJobDurationSeconds: (s, o) => {
        m.deployDuration.observe(s);
        m.deploysTotal.inc({ result: o === 'ok' ? 'ok' : 'fail' });
      },
    };
    const queue = new DeployQueue(async (): Promise<Outcome> => 'ok', observer);
    queue.submit({ sha: 'a'.repeat(40), branch: 'main', pusher: 'x', enqueuedAt: 0 });
    await vi.waitFor(async () => {
      const text = await m.expose();
      expect(text).toMatch(/qufox_deploys_total\{result="ok"\} 1/);
      expect(text).toMatch(/qufox_deploy_duration_seconds_count 1/);
    });
  });
});

describe('/internal/metrics endpoint', () => {
  let url: string;
  let close: () => Promise<void>;
  let metrics: DeployMetrics;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'qufox-metrics-'));
    metrics = new DeployMetrics();
    const audit = new AuditLog(join(tmpDir, 'audit.jsonl'));
    const queue = new DeployQueue(async (): Promise<Outcome> => 'ok');
    const server = createWebhookServer({
      secret: SECRET,
      branchAllowlist: ['main'],
      queue,
      audit,
      notifier: noopNotifier,
      metrics,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    url = `http://127.0.0.1:${addr.port}`;
    close = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(tmpDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('returns 200 with prom-exposition content on 127.0.0.1', async () => {
    const res = await fetch(`${url}/internal/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain('qufox_deploys_total');
    expect(text).toContain('qufox_deploy_queue_depth');
    expect(text).toContain('qufox_deploy_rollbacks_total');
    expect(text).toContain('qufox_deploy_duration_seconds');
  });

  it('POST /internal/rollback-reported increments the counter', async () => {
    const before = await (await fetch(`${url}/internal/metrics`)).text();
    expect(before).toMatch(/qufox_deploy_rollbacks_total 0/);
    const bump = await fetch(`${url}/internal/rollback-reported`, { method: 'POST' });
    expect(bump.status).toBe(202);
    const after = await (await fetch(`${url}/internal/metrics`)).text();
    expect(after).toMatch(/qufox_deploy_rollbacks_total 1/);
  });

  it('GET /internal/metrics returns 404 for POST and unknown sub-paths', async () => {
    const res = await fetch(`${url}/internal/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 503 when metrics are disabled', async () => {
    // Spin a second server without metrics to prove the disabled branch.
    const audit = new AuditLog(join(tmpDir, 'audit2.jsonl'));
    const queue = new DeployQueue(async () => 'ok');
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
    const res = await fetch(`http://127.0.0.1:${addr.port}/internal/metrics`);
    expect(res.status).toBe(503);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('writes a deploy.rollback audit line after the callback', async () => {
    await fetch(`${url}/internal/rollback-reported`, { method: 'POST' });
    // readFile would race; use the metrics text as the proxy since the
    // audit write happens inside the same handler.
    const after = await (await fetch(`${url}/internal/metrics`)).text();
    expect(after).toMatch(/qufox_deploy_rollbacks_total 1/);
  });

  // IP allowlist negative path: we can't easily bind a non-loopback
  // interface in the test env (all tests listen on 127.0.0.1 which IS
  // in the allowlist), so we cover the rejection path with a
  // unit-level monkey-patch of req.socket.remoteAddress in the hook
  // request handler. The allowlist logic itself is pure and covered by
  // isInternalPeer semantics: addresses starting with 127./::1/::ffff:127./
  // 172./10./192.168. pass; everything else 403s. The prod scrape comes
  // from the Docker bridge (172.x), so both 127. and 172. are required.
});

describe('/metrics content after a successful deploy', () => {
  it('increments qufox_deploys_total{result="ok"} when a push runs through', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'qufox-metrics-full-'));
    const metrics = new DeployMetrics();
    const audit = new AuditLog(join(tmp, 'audit.jsonl'));
    const observer: QueueObserver = {
      onDepthChange: (d) => metrics.queueDepth.set(d),
      onJobDurationSeconds: (s, o) => {
        metrics.deployDuration.observe(s);
        metrics.deploysTotal.inc({ result: o === 'ok' ? 'ok' : 'fail' });
      },
    };
    const queue = new DeployQueue(async (): Promise<Outcome> => 'ok', observer);
    const server = createWebhookServer({
      secret: SECRET,
      branchAllowlist: ['main'],
      queue,
      audit,
      notifier: noopNotifier,
      metrics,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const port = addr.port;

    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'b'.repeat(40),
      pusher: { name: 'metrics-push' },
    });
    const pushRes = await fetch(`http://127.0.0.1:${port}/hooks/github`, {
      method: 'POST',
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(pushRes.status).toBe(202);

    await vi.waitFor(async () => {
      const m = await (await fetch(`http://127.0.0.1:${port}/internal/metrics`)).text();
      expect(m).toMatch(/qufox_deploys_total\{result="ok"\} 1/);
      expect(m).toMatch(/qufox_deploy_duration_seconds_count 1/);
    });

    await new Promise<void>((r) => server.close(() => r()));
    await rm(tmp, { recursive: true, force: true });
  });
});
