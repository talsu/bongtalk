import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuditLog } from './audit';
import { extractBranch, verifySignature } from './hmac';
import type { Notifier } from './notify';
import type { DeployQueue } from './queue';

export interface ServerDeps {
  secret: string;
  branchAllowlist: readonly string[];
  queue: DeployQueue;
  audit: AuditLog;
  notifier: Notifier;
}

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  pusher?: { name?: unknown };
  deleted?: unknown;
}

function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function createWebhookServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((err) => {
      process.stderr.write(`[webhook.server] unhandled: ${String(err)}\n`);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    json(res, 200, { status: 'ok' });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/hooks/github') {
    json(res, 404, { error: 'not found' });
    return;
  }

  const event = asString(req.headers['x-github-event']);
  const delivery = asString(req.headers['x-github-delivery']);
  const signature = asString(req.headers['x-hub-signature-256']);

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    await deps.audit.append('request.reject', {
      reason: 'body',
      error: (err as Error).message,
      delivery,
    });
    json(res, 400, { error: 'bad body' });
    return;
  }

  if (!signature || !verifySignature(deps.secret, body, signature)) {
    await deps.audit.append('request.reject', { reason: 'signature', delivery, event });
    json(res, 401, { error: 'bad signature' });
    return;
  }

  if (event === 'ping') {
    await deps.audit.append('request.ping', { delivery });
    json(res, 200, { pong: true });
    return;
  }

  if (event !== 'push') {
    await deps.audit.append('request.ignore', { reason: 'event', event, delivery });
    json(res, 200, { ignored: true, reason: 'unsupported event' });
    return;
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(body.toString('utf8')) as PushPayload;
  } catch {
    await deps.audit.append('request.reject', { reason: 'json', delivery });
    json(res, 400, { error: 'bad json' });
    return;
  }

  if (payload.deleted === true) {
    await deps.audit.append('request.ignore', { reason: 'deleted', delivery });
    json(res, 200, { ignored: true, reason: 'branch delete' });
    return;
  }

  const branch = typeof payload.ref === 'string' ? extractBranch(payload.ref) : null;
  const sha = typeof payload.after === 'string' ? payload.after : null;
  const pusher =
    payload.pusher && typeof payload.pusher.name === 'string' ? payload.pusher.name : 'unknown';

  if (!branch || !sha) {
    await deps.audit.append('request.reject', { reason: 'shape', delivery });
    json(res, 400, { error: 'missing ref or after' });
    return;
  }

  if (!deps.branchAllowlist.includes(branch)) {
    await deps.audit.append('request.ignore', {
      reason: 'branch',
      branch,
      sha,
      pusher,
      delivery,
    });
    json(res, 200, { ignored: true, reason: 'branch not in allowlist' });
    return;
  }

  const submission = deps.queue.submit({ sha, branch, pusher, enqueuedAt: Date.now() });
  await deps.audit.append('deploy.enqueue', { sha, branch, pusher, delivery, submission });
  if (submission === 'started') {
    await deps.notifier.send(`🚀 deploy started — ${branch}@${sha.slice(0, 7)} by ${pusher}`);
  }
  json(res, 202, { accepted: true, submission, sha });
}

function asString(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return '';
}
