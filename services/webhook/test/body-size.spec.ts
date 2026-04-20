import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/audit';
import { noopNotifier } from '../src/notify';
import { DeployQueue, type DeployJob, type Outcome } from '../src/queue';
import { createWebhookServer } from '../src/server';

const SECRET = 'body-size-test';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

/**
 * Regression guard for review finding #4: GitHub push payloads can reach
 * ~25 MB (force-pushes, branch-drops with many commits). The receiver's
 * old 1 MB cap would 400 legitimate pushes with no Slack signal. Body
 * cap is now 32 MB — 1.5 MB must succeed.
 */
describe('webhook body size cap', () => {
  let url: string;
  let close: () => Promise<void>;
  let submitted: DeployJob[];
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'qufox-bodysize-'));
    submitted = [];
    const audit = new AuditLog(join(tmpDir, 'audit.jsonl'));
    const queue = new DeployQueue(async (j): Promise<Outcome> => {
      submitted.push(j);
      return 'ok';
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
    url = `http://127.0.0.1:${addr.port}/hooks/github`;
    close = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(tmpDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('accepts a 1.5 MB push payload (old 1 MB cap would have 400ed)', async () => {
    const filler = 'x'.repeat(1_600_000);
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      pusher: { name: 'big-push' },
      // Single large field that pushes the JSON above 1.5 MB.
      _filler: filler,
    });
    expect(body.length).toBeGreaterThan(1_500_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
  });
});
