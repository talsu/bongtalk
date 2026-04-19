import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuditLog } from './audit';
import { extractBranch, verifySignature } from './hmac';
import type { DeployMetrics } from './metrics';
import type { Notifier } from './notify';
import type { DeployQueue } from './queue';

export interface ServerDeps {
  secret: string;
  branchAllowlist: readonly string[];
  queue: DeployQueue;
  audit: AuditLog;
  notifier: Notifier;
  metrics?: DeployMetrics;
}

/**
 * Only these peer IPs are allowed to hit `/internal/*`. The webhook
 * container binds to 127.0.0.1:9000 on the host, so the internal routes
 * accept loopback + the Docker bridge range (Prometheus sidecar scrapes
 * over `internal` network). We reject everything else so a misconfigured
 * nginx upstream couldn't accidentally expose metrics.
 */
const INTERNAL_ALLOWED_PREFIXES = ['127.', '::1', '::ffff:127.', '172.', '10.', '192.168.'];

function isInternalPeer(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return INTERNAL_ALLOWED_PREFIXES.some((p) => addr.startsWith(p));
}

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  pusher?: { name?: unknown };
  deleted?: unknown;
}

// GitHub push payloads can be up to ~25 MB (big initial pushes,
// force-pushes of large ranges, branches with many commits in one push).
// nginx's client_max_body_size 25m at the edge matches this ceiling;
// keeping the receiver's cap lower would 400 legitimate pushes and the
// operator would see "request.reject reason=body" in the audit log with
// no Slack signal. 32 MB gives headroom without enabling abuse.
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
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

  if (req.method === 'GET' && req.url === '/internal/metrics') {
    if (!deps.metrics) {
      json(res, 503, { error: 'metrics disabled' });
      return;
    }
    if (!isInternalPeer(req)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    const body = await deps.metrics.expose();
    res.statusCode = 200;
    res.setHeader('content-type', deps.metrics.contentType());
    res.end(body);
    return;
  }

  // Rollback reporter — called by scripts/deploy/rollback.sh via
  // `curl -XPOST http://127.0.0.1:9000/internal/rollback-reported`.
  // Increments the rollback counter. Fail-open: if the webhook is down
  // rollback.sh's exit status is still authoritative; we just miss the
  // counter bump.
  if (req.method === 'POST' && req.url === '/internal/rollback-reported') {
    if (!isInternalPeer(req)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    deps.metrics?.rollbacksTotal.inc();
    await deps.audit.append('deploy.rollback', {
      source: 'rollback.sh',
      peer: req.socket.remoteAddress,
    });
    json(res, 202, { accepted: true });
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
