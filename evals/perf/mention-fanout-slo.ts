/**
 * S88c (FR-MN-21) — @here fan-out SLO eval.
 *
 * Measures the client-side, end-to-end delivery latency of a single `@here`
 * mention to N ONLINE channel members and asserts the P95 stays under the SLO
 * (default 5s). Reuses the soak harness REST helper pattern (signup → login →
 * workspace → channel → invite/accept) and connects each member with
 * `socket.io-client` over the websocket transport, exactly like the web client
 * (apps/web/src/lib/socket.ts):
 *   - handshake auth carries the access token (`auth.accessToken`)
 *   - the gateway eager-joins channel rooms from membership on connect
 *     (no explicit join event), then emits `connection:ready`
 *   - online channel members receive `mention:new` on their `user:{id}` room
 *
 * SCENARIO (ADR 062 · C3):
 *   1. CONN_COUNT users signup/login. The first user owns one workspace + one
 *      TEXT channel; the rest join via a single-use invite link, so every user
 *      is a member of the channel.
 *   2. Each user opens a websocket and waits for `connection:ready`.
 *   3. One sender POSTs a single `@here` message (REST). We stamp t0 right
 *      before the POST resolves.
 *   4. Every receiver records the arrival time of its `mention:new`. We compute
 *      (arrival - t0) for every reached receiver → P95.
 *   5. If PROMETHEUS_URL is set we also report the @role async BullMQ job
 *      latency P95 (bullmq_job_duration_seconds{queue="mention-broadcast"}),
 *      since FR-MN-21 asks for the BullMQ latency to be reported alongside.
 *
 * @here is SYNCHRONOUS fan-out (ADR C1) — the BullMQ queue carries @role only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EMAIL-GATE CONSTRAINT (read before running against prod) ─ S88c
 * ─────────────────────────────────────────────────────────────────────────────
 * S66 added an email-verification gate: a freshly signed-up account has
 * `emailVerified=false` and is rejected with `403 EMAIL_NOT_VERIFIED` when it
 * tries to create/enter a workspace (apps/api/src/workspaces/
 * workspace-entry-gate.ts). The gate has NO env bypass — that is correct app
 * behaviour. Consequently the signup→workspace self-bootstrap path below cannot
 * run against an email-gated stack (prod included): it will hit the gate at the
 * `createWorkspace` step. This is a fundamental constraint, identical to the
 * soak harness. Pick one of the two run modes accordingly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN MODE A — signup-bootstrap (default; dev / ungated test stack only)
 * ─────────────────────────────────────────────────────────────────────────────
 * CONN_COUNT accounts are created on the fly (signup → workspace → channel →
 * invite/accept). Requires a stack WITHOUT the email gate (or one whose seed
 * marks accounts `emailVerified=true`). This is the recommended way to run the
 * full 100-user load: point BASE_URL at a dedicated test compose stack so the
 * traffic never touches prod.
 *
 *   # full 100-user load against a local/test stack (no email gate)
 *   CONN_COUNT=100 PERF_CLEANUP=true \
 *     BASE_URL=http://localhost:43001 SOAK_ORIGIN=http://localhost:45173 \
 *     pnpm perf:mention-slo
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN MODE B — PERF_REUSE (pre-provisioned, pre-verified accounts; any stack)
 * ─────────────────────────────────────────────────────────────────────────────
 * For an email-gated stack (prod included) you provision the accounts +
 * workspace + channel ONCE out of band (already email-verified and already
 * members of the channel), then this harness only logs in and measures —
 * signup, workspace/channel creation and cleanup are all skipped.
 *
 * Set `PERF_REUSE=1` plus:
 *   - owner credentials (one of):
 *       PERF_OWNER_TOKEN                  a valid owner access token, OR
 *       PERF_OWNER_EMAIL + PERF_OWNER_PASSWORD   (logged in to obtain a token)
 *   - PERF_WORKSPACE_ID  existing workspace id (reused; not created/deleted)
 *   - PERF_CHANNEL_ID    existing TEXT channel id the owner posts the @here to
 *   - PERF_ACCOUNTS_FILE path to a JSON array `[{ "email", "password" }, ...]`
 *       with at least CONN_COUNT-1 entries (the owner is the Nth member). Each
 *       is logged in to obtain a token; every account must ALREADY be a member
 *       of PERF_CHANNEL_ID and ALREADY email-verified.
 *
 *   # measure against an email-gated stack with reused accounts
 *   PERF_REUSE=1 CONN_COUNT=100 \
 *     PERF_OWNER_EMAIL=owner@example.com PERF_OWNER_PASSWORD=… \
 *     PERF_WORKSPACE_ID=ws_… PERF_CHANNEL_ID=ch_… \
 *     PERF_ACCOUNTS_FILE=./perf-accounts.json \
 *     BASE_URL=https://qufox.com/api SOAK_ORIGIN=https://qufox.com \
 *     pnpm perf:mention-slo
 *
 * Both modes converge on the same measurement: WS connect → channel join →
 * @here → mention:new P95. PERF_CLEANUP is ignored in PERF_REUSE mode (we never
 * created the workspace, so we never delete it).
 *
 * Exit codes:
 *   0  measured P95 within SLO_P95_MS (or a clean PASS)
 *   1  P95 breach, no delivery, or an unexpected setup/run error
 *   2  graceful preflight stop — the bootstrap hit the email gate (or another
 *      4xx) on an email-gated stack. The message tells the operator to use a
 *      test stack or PERF_REUSE. This is NOT a harness bug.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { io, type Socket } from 'socket.io-client';
import { queryPrometheus } from '../soak/collect-metrics';

// Distinct exit code for a graceful preflight stop (bootstrap blocked by the
// email gate / a 4xx) so an operator or CI can tell "wrong stack / needs
// PERF_REUSE" apart from a real SLO breach (1) or a clean pass (0).
const EXIT_PREFLIGHT_STOP = 2;

/**
 * Raised when the dev-stack signup-bootstrap cannot proceed because the target
 * stack enforces the email-verification gate (or returns another client error)
 * — i.e. the harness is pointed at the wrong stack and should switch to a test
 * stack or PERF_REUSE. Carries the dedicated exit code so `main()` can stop
 * cleanly instead of crashing with a stack trace.
 */
class PreflightStop extends Error {
  readonly exitCode = EXIT_PREFLIGHT_STOP;
  constructor(message: string) {
    super(message);
    this.name = 'PreflightStop';
  }
}

// ── WS wire event names (kept inline so the eval stays self-contained, like the
//    soak runner; these mirror packages/shared-types/src/events.ts WS_EVENTS). ──
const WS_CONNECTION_READY = 'connection:ready';
const WS_MENTION_NEW = 'mention:new';
const WS_MESSAGE_CREATED = 'message:created';

// ── env ──────────────────────────────────────────────────────────────────────
const CONN_COUNT = Math.max(2, Number(process.env.CONN_COUNT ?? 100));
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:43001';
const ORIGIN = process.env.SOAK_ORIGIN ?? 'http://localhost:45173';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? null;
const SLO_P95_MS = Number(process.env.SLO_P95_MS ?? 5000);
const PERF_CLEANUP = (process.env.PERF_CLEANUP ?? 'true').toLowerCase() !== 'false';
// Max time to wait for receivers to observe their `mention:new` after the POST.
const DELIVERY_TIMEOUT_MS = Number(process.env.PERF_DELIVERY_TIMEOUT_MS ?? 30_000);
// Max time to wait for every socket to report `connection:ready` on connect.
const CONNECT_TIMEOUT_MS = Number(process.env.PERF_CONNECT_TIMEOUT_MS ?? 30_000);
const PASSWORD = 'Quanta-Beetle-Nebula-42!';

// ── PERF_REUSE mode (run mode B — pre-provisioned, pre-verified accounts) ─────
// When set, signup/workspace/channel creation (and cleanup) are skipped; the
// harness only logs in to reuse-already-provisioned accounts. See the file
// header for the full env contract.
const PERF_REUSE = ['1', 'true', 'yes'].includes((process.env.PERF_REUSE ?? '').toLowerCase());
const PERF_OWNER_TOKEN = process.env.PERF_OWNER_TOKEN ?? null;
const PERF_OWNER_EMAIL = process.env.PERF_OWNER_EMAIL ?? null;
const PERF_OWNER_PASSWORD = process.env.PERF_OWNER_PASSWORD ?? null;
const PERF_WORKSPACE_ID = process.env.PERF_WORKSPACE_ID ?? null;
const PERF_CHANNEL_ID = process.env.PERF_CHANNEL_ID ?? null;
const PERF_ACCOUNTS_FILE = process.env.PERF_ACCOUNTS_FILE ?? null;

/** A pre-provisioned account entry from PERF_ACCOUNTS_FILE. */
type ReuseAccount = { email: string; password: string };

/**
 * Socket.IO origin. Mirrors apps/web/src/lib/socket.ts `socketOrigin()`:
 * the gateway lives at the page origin, not under `/api`, so strip a trailing
 * `/api` from BASE_URL when present.
 */
function socketOrigin(): string {
  return process.env.WS_ORIGIN ?? BASE_URL.replace(/\/api\/?$/, '');
}

/**
 * HTTP error that preserves the response status + the domain `errorCode` (when
 * the body is the standard `{ errorCode, message, ... }` envelope). Preflight
 * uses `.errorCode === 'EMAIL_NOT_VERIFIED'` (and the 4xx status) to decide
 * whether to stop gracefully rather than crash.
 */
class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly bodySnippet: string,
  ) {
    super(`${url} → ${status}${errorCode ? ` ${errorCode}` : ''} ${bodySnippet}`);
    this.name = 'HttpError';
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const raw = await res.text();
    let errorCode: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { errorCode?: unknown };
      if (typeof parsed.errorCode === 'string') errorCode = parsed.errorCode;
    } catch {
      /* non-JSON error body — keep errorCode null, surface the snippet */
    }
    throw new HttpError(url, res.status, errorCode, raw.slice(0, 200));
  }
  // Some endpoints (DELETE) may return 202 with a small body; tolerate empty.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// ── REST helpers (same shape as evals/soak/run.ts buildApi) ──────────────────
const api = {
  async signup(email: string, username: string, password: string) {
    const r = await fetchJson<{ accessToken: string; user: { id: string } }>(
      `${BASE_URL}/auth/signup`,
      { method: 'POST', body: JSON.stringify({ email, username, password }) },
    );
    return { accessToken: r.accessToken, userId: r.user.id };
  },
  async login(email: string, password: string) {
    const r = await fetchJson<{ accessToken: string; user: { id: string } }>(
      `${BASE_URL}/auth/login`,
      { method: 'POST', body: JSON.stringify({ email, password }) },
    );
    return { accessToken: r.accessToken, userId: r.user.id };
  },
  async me(token: string) {
    const r = await fetchJson<{ id: string }>(`${BASE_URL}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { userId: r.id };
  },
  async createWorkspace(token: string, slug: string) {
    const r = await fetchJson<{ id: string }>(`${BASE_URL}/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: `Perf ${slug}`, slug }),
    });
    return { id: r.id };
  },
  async createChannel(token: string, wsId: string, name: string) {
    const r = await fetchJson<{ id: string; name: string }>(
      `${BASE_URL}/workspaces/${wsId}/channels`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, type: 'TEXT' }),
      },
    );
    return { id: r.id, name: r.name };
  },
  async invite(token: string, wsId: string, maxUses: number) {
    const r = await fetchJson<{ invite: { code: string } }>(
      `${BASE_URL}/workspaces/${wsId}/invites`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ maxUses }),
      },
    );
    return { code: r.invite.code };
  },
  async accept(token: string, code: string) {
    await fetchJson(`${BASE_URL}/invites/${code}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  },
  async sendMessage(token: string, wsId: string, chId: string, content: string) {
    await fetchJson(`${BASE_URL}/workspaces/${wsId}/channels/${chId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ content }),
    });
  },
  async deleteWorkspace(token: string, wsId: string, confirmation: string) {
    await fetchJson(`${BASE_URL}/workspaces/${wsId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirmation }),
    });
  },
};

type Member = { token: string; userId: string };

/**
 * Outcome of either bootstrap path. `members[0]` is always the owner/sender.
 * `cleanup` is provided only by the signup-bootstrap path (it created the
 * workspace and may delete it); PERF_REUSE never creates anything, so its
 * cleanup is a no-op.
 */
type Bootstrap = {
  members: Member[];
  workspaceId: string;
  channelId: string;
  slug: string;
  cleanup: () => Promise<void>;
};

function requireEnv(name: string, value: string | null): string {
  if (value === null || value.trim() === '') {
    throw new Error(
      `PERF_REUSE mode requires ${name}. See the file header for the full env contract.`,
    );
  }
  return value;
}

async function readAccountsFile(path: string): Promise<ReuseAccount[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`PERF_ACCOUNTS_FILE could not be read (${path}): ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PERF_ACCOUNTS_FILE is not valid JSON (${path}): ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`PERF_ACCOUNTS_FILE must be a JSON array of { email, password } (${path})`);
  }
  const accounts: ReuseAccount[] = parsed.map((entry, i) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>).email !== 'string' ||
      typeof (entry as Record<string, unknown>).password !== 'string'
    ) {
      throw new Error(
        `PERF_ACCOUNTS_FILE[${i}] must be { "email": string, "password": string } (${path})`,
      );
    }
    const e = entry as Record<string, unknown>;
    return { email: e.email as string, password: e.password as string };
  });
  return accounts;
}

/**
 * Run mode B — PERF_REUSE: log in to pre-provisioned, pre-verified accounts and
 * reuse an existing workspace/channel. No signup, no creation, no cleanup. Every
 * env is validated up front with a clear error on omission.
 */
async function bootstrapReuse(): Promise<Bootstrap> {
  // Validate every required env (and the accounts file itself) BEFORE any
  // network call, so a misconfiguration produces a clear, deterministic error
  // regardless of whether the target API is reachable.
  const workspaceId = requireEnv('PERF_WORKSPACE_ID', PERF_WORKSPACE_ID);
  const channelId = requireEnv('PERF_CHANNEL_ID', PERF_CHANNEL_ID);
  const accountsFile = requireEnv('PERF_ACCOUNTS_FILE', PERF_ACCOUNTS_FILE);
  const hasOwnerToken = PERF_OWNER_TOKEN !== null && PERF_OWNER_TOKEN.trim() !== '';
  const hasOwnerLogin =
    PERF_OWNER_EMAIL !== null &&
    PERF_OWNER_EMAIL.trim() !== '' &&
    PERF_OWNER_PASSWORD !== null &&
    PERF_OWNER_PASSWORD.trim() !== '';
  if (!hasOwnerToken && !hasOwnerLogin) {
    throw new Error(
      'PERF_REUSE mode requires either PERF_OWNER_TOKEN or PERF_OWNER_EMAIL + PERF_OWNER_PASSWORD. ' +
        'See the file header for the full env contract.',
    );
  }
  const accounts = await readAccountsFile(accountsFile);
  const needed = CONN_COUNT - 1; // owner is the Nth member
  if (accounts.length < needed) {
    throw new Error(
      `PERF_ACCOUNTS_FILE has ${accounts.length} account(s) but CONN_COUNT=${CONN_COUNT} ` +
        `needs ${needed} non-owner member(s) (plus the owner). Provide more accounts or lower CONN_COUNT.`,
    );
  }

  // Owner: an explicit token (resolved to a userId via /auth/me), else login.
  const owner: Member = hasOwnerToken
    ? {
        token: PERF_OWNER_TOKEN as string,
        userId: (await api.me(PERF_OWNER_TOKEN as string)).userId,
      }
    : await api
        .login(PERF_OWNER_EMAIL as string, PERF_OWNER_PASSWORD as string)
        .then((r) => ({ token: r.accessToken, userId: r.userId }));

  const members: Member[] = [owner];
  for (let i = 0; i < needed; i++) {
    const acc = accounts[i];
    const r = await api.login(acc.email, acc.password);
    members.push({ token: r.accessToken, userId: r.userId });
  }

  return {
    members,
    workspaceId,
    channelId,
    slug: `reuse-${workspaceId}`,
    cleanup: async () => {
      /* PERF_REUSE never created the workspace → never deletes it */
    },
  };
}

/**
 * Run mode A — signup-bootstrap (dev / ungated test stack only): create
 * CONN_COUNT accounts, a workspace, a TEXT channel, and join everyone. Wrapped
 * by `preflightBootstrap` so the email gate surfaces as a graceful stop rather
 * than a crash.
 */
async function bootstrapSignup(runId: string, stamp: string): Promise<Bootstrap> {
  const members: Member[] = [];
  for (let i = 0; i < CONN_COUNT; i++) {
    const email = `perf-${runId}-${stamp}-${i}@qufox.dev`;
    const username = `perf${stamp}${i}`;
    const u = await api.signup(email, username, PASSWORD);
    members.push({ token: u.accessToken, userId: u.userId });
  }
  const owner = members[0];

  const slug = `perf-${runId}-${stamp}`;
  const ws = await api.createWorkspace(owner.token, slug);
  const channel = await api.createChannel(owner.token, ws.id, `general-${stamp}`);

  // One invite per joiner (maxUses=1 mirrors the soak member-churn helper).
  for (let i = 1; i < members.length; i++) {
    const inv = await api.invite(owner.token, ws.id, 1);
    await api.accept(members[i].token, inv.code);
  }

  return {
    members,
    workspaceId: ws.id,
    channelId: channel.id,
    slug,
    cleanup: async () => {
      if (!PERF_CLEANUP) {
        console.log(`[perf] PERF_CLEANUP=false → leaving workspace ${ws.id} (slug=${slug})`);
        return;
      }
      try {
        await api.deleteWorkspace(owner.token, ws.id, slug);
        console.log(`[perf] cleanup: workspace ${ws.id} deleted`);
      } catch (err) {
        console.warn(`[perf] cleanup failed (workspace ${ws.id}): ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Wrap the signup-bootstrap so an email-gate rejection (or any other 4xx) at
 * the workspace/invite step is reported as an actionable PreflightStop instead
 * of a raw stack trace — the operator is told to use a test stack or PERF_REUSE.
 */
async function preflightBootstrap(runId: string, stamp: string): Promise<Bootstrap> {
  try {
    return await bootstrapSignup(runId, stamp);
  } catch (err) {
    if (
      err instanceof HttpError &&
      (err.errorCode === 'EMAIL_NOT_VERIFIED' || err.status === 403)
    ) {
      throw new PreflightStop(
        `signup-bootstrap blocked by the email gate (${err.status}` +
          `${err.errorCode ? ` ${err.errorCode}` : ''}). 이 SLO 하니스는 이메일 인증 게이트가 ` +
          '없는 테스트/dev 스택 대상이거나 사전검증 계정이 필요합니다. ' +
          '(1) 테스트 compose 스택(이메일 게이트 우회/DB-seed verified) 에 BASE_URL 을 지정하거나, ' +
          '(2) PERF_REUSE=1 모드로 사전 검증된 계정을 제공하세요. 자세한 건 파일 헤더를 참조하세요.',
      );
    }
    // Any other 4xx during bootstrap is likely a wrong-stack/config issue too —
    // surface the same actionable guidance with the dedicated exit code.
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
      throw new PreflightStop(
        `signup-bootstrap failed with ${err.status}${err.errorCode ? ` ${err.errorCode}` : ''} ` +
          `(${err.bodySnippet}). 부트스트랩이 클라이언트 오류로 막혔습니다. ` +
          '이메일 게이트가 없는 테스트/dev 스택에 BASE_URL 을 지정하거나 PERF_REUSE=1 모드를 사용하세요. ' +
          '자세한 건 파일 헤더를 참조하세요.',
      );
    }
    // The API was unreachable (connection refused / DNS / TLS) — a `fetch failed`
    // TypeError. Tell the operator the stack is down / BASE_URL is wrong rather
    // than crashing with a bare network error.
    if (err instanceof TypeError) {
      throw new PreflightStop(
        `signup-bootstrap could not reach the API at ${BASE_URL} (${err.message}). ` +
          'API 스택에 도달하지 못했습니다(연결 거부/DNS/TLS). 이메일 게이트가 없는 테스트/dev ' +
          '스택이 떠 있는지, BASE_URL/SOAK_ORIGIN 이 맞는지 확인하거나 PERF_REUSE=1 모드를 사용하세요. ' +
          '자세한 건 파일 헤더를 참조하세요.',
      );
    }
    throw err;
  }
}

type Receiver = {
  userId: string;
  socket: Socket;
  /** epoch ms when this socket observed its `mention:new`, or null if none. */
  receivedAt: number | null;
  /** whether this socket saw the channel `message:created` for the probe. */
  sawMessage: boolean;
};

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  // Nearest-rank percentile (matches what k6/Prometheus report colloquially).
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/** Connect one socket and resolve when `connection:ready` lands (or timeout). */
function connectReady(userId: string, accessToken: string): Promise<Receiver> {
  return new Promise<Receiver>((resolve, reject) => {
    const socket = io(socketOrigin(), {
      auth: { accessToken },
      transports: ['websocket'],
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    const receiver: Receiver = { userId, socket, receivedAt: null, sawMessage: false };
    const timer = setTimeout(() => {
      socket.off(WS_CONNECTION_READY, onReady);
      reject(new Error(`connection:ready timeout for user=${userId}`));
    }, CONNECT_TIMEOUT_MS);

    const onReady = (): void => {
      clearTimeout(timer);
      resolve(receiver);
    };
    socket.once(WS_CONNECTION_READY, onReady);
    socket.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`connect_error user=${userId}: ${err.message}`));
    });
    // Record delivery the instant `mention:new` arrives — this is the FR-MN-21
    // delivery signal (the gateway pushes it to the receiver's `user:{id}` room
    // when an @here reaches an online channel member). We mark `receivedAt` once
    // and only via `mention:new` so the measured latency is the mention path.
    socket.on(WS_MENTION_NEW, () => {
      if (receiver.receivedAt === null) receiver.receivedAt = Date.now();
    });
    // The gateway also fans out `message:created` to the channel room. We don't
    // use it as the SLO timestamp (it isn't the mention signal), but tracking
    // it lets the report distinguish "message landed but no mention" cases.
    socket.on(WS_MESSAGE_CREATED, () => {
      receiver.sawMessage = true;
    });
  });
}

function disconnectAll(receivers: Receiver[]): void {
  for (const r of receivers) {
    try {
      r.socket.removeAllListeners();
      r.socket.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }
}

async function reportBullmqLatency(): Promise<void> {
  if (!PROMETHEUS_URL) {
    console.log('[perf] PROMETHEUS_URL unset → skipping @role BullMQ latency report');
    return;
  }
  // FR-MN-21: report the @role async job latency P95. @here is synchronous, so
  // this is a complementary signal (S88b mention-broadcast queue).
  const promql =
    'histogram_quantile(0.95, sum by (le) (rate(bullmq_job_duration_seconds_bucket{queue="mention-broadcast"}[5m])))';
  const res = await queryPrometheus(PROMETHEUS_URL, promql);
  const v = res.value;
  console.log(
    `[perf] @role mention-broadcast job latency P95: ${
      v === null ? 'n/a (no recent samples)' : `${(v * 1000).toFixed(0)}ms`
    }`,
  );
}

async function main(): Promise<number> {
  const runId = randomUUID().slice(0, 8);
  const stamp = Date.now().toString(36);
  console.log(
    `[perf] mention-fanout-slo run=${runId} conn=${CONN_COUNT} slo=${SLO_P95_MS}ms base=${BASE_URL} ` +
      `wsOrigin=${socketOrigin()} mode=${PERF_REUSE ? 'PERF_REUSE (reuse)' : 'signup-bootstrap'}`,
  );

  // ── 1+2. bootstrap members + workspace + channel ───────────────────────────
  // PERF_REUSE → log into pre-provisioned, pre-verified accounts (works on an
  // email-gated stack). Otherwise → signup-bootstrap, wrapped so the email gate
  // surfaces as a graceful PreflightStop (exit 2) instead of a crash.
  const boot = PERF_REUSE ? await bootstrapReuse() : await preflightBootstrap(runId, stamp);
  const { members, workspaceId, channelId } = boot;
  const owner = members[0];

  let exitCode = 0;
  let receivers: Receiver[] = [];
  try {
    // ── 3. connect every member's websocket + await connection:ready ─────────
    // The sender is the owner; receivers are everyone else (a user never gets
    // a `mention:new` for their own message). We still connect the sender so it
    // is ONLINE-in-channel, matching the "@here = online members" semantics.
    const connectResults = await Promise.allSettled(
      members.map((m) => connectReady(m.userId, m.token)),
    );
    receivers = connectResults
      .filter((r): r is PromiseFulfilledResult<Receiver> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failedConnects = connectResults.length - receivers.length;
    if (failedConnects > 0) {
      console.warn(`[perf] ${failedConnects}/${members.length} sockets failed to become ready`);
    }
    if (receivers.length < 2) {
      throw new Error(`only ${receivers.length} sockets ready — need at least 2 to measure`);
    }

    const senderUserId = owner.userId;
    const targets = receivers.filter((r) => r.userId !== senderUserId);
    if (targets.length === 0) {
      throw new Error('sender socket ready but no receiver sockets — cannot measure');
    }

    // Brief settle so every socket has finished joining its channel room before
    // the POST (eager-join completes before connection:ready, but a tiny grace
    // absorbs adapter/Redis propagation on a loaded node).
    await sleep(500);

    // ── 4. POST one @here message; stamp t0 at send-resolve ──────────────────
    const content = `@here SLO probe ${runId} ${new Date().toISOString()}`;
    const t0 = Date.now();
    await api.sendMessage(owner.token, workspaceId, channelId, content);

    // ── 5. wait until all targets received (or timeout) ──────────────────────
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (targets.every((t) => t.receivedAt !== null)) break;
      await sleep(100);
    }

    const latencies = targets
      .filter((t) => t.receivedAt !== null)
      .map((t) => (t.receivedAt as number) - t0)
      .sort((a, b) => a - b);
    const reached = latencies.length;
    const notReached = targets.length - reached;
    const deliveryRate = targets.length > 0 ? reached / targets.length : 0;
    const sawMessageCount = targets.filter((t) => t.sawMessage).length;

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const min = latencies[0] ?? NaN;
    const max = latencies[latencies.length - 1] ?? NaN;

    const fmt = (n: number): string => (Number.isFinite(n) ? `${n}ms` : 'n/a');
    console.log('');
    console.log('  ┌─ @here fan-out SLO (FR-MN-21) ────────────────────────────');
    console.log(`  │ targets (online, non-sender) : ${targets.length}`);
    console.log(`  │ reached (mention:new)         : ${reached}`);
    console.log(`  │ not reached                   : ${notReached}`);
    console.log(`  │ saw message:created           : ${sawMessageCount}`);
    console.log(`  │ delivery rate                 : ${(deliveryRate * 100).toFixed(1)}%`);
    console.log(`  │ latency min                   : ${fmt(min)}`);
    console.log(`  │ latency p50                   : ${fmt(p50)}`);
    console.log(`  │ latency p95                   : ${fmt(p95)}`);
    console.log(`  │ latency max                   : ${fmt(max)}`);
    console.log(`  │ SLO (p95)                     : < ${SLO_P95_MS}ms`);
    console.log('  └────────────────────────────────────────────────────────────');
    console.log('');

    // FR-MN-21 BullMQ latency report (complementary; @role async path).
    await reportBullmqLatency();

    // ── 6. verdict ───────────────────────────────────────────────────────────
    if (reached === 0) {
      console.error('[perf] FAIL: no receiver observed mention:new within timeout');
      exitCode = 1;
    } else if (!Number.isFinite(p95) || p95 > SLO_P95_MS) {
      console.error(`[perf] FAIL: p95 ${fmt(p95)} exceeds SLO ${SLO_P95_MS}ms`);
      exitCode = 1;
    } else if (notReached > 0) {
      console.warn(
        `[perf] WARN: p95 within SLO but ${notReached} target(s) never received (partial delivery)`,
      );
      // Partial delivery is a soft signal — the headline SLO is the P95 of
      // reached receivers. We do not fail on it here; the count is reported.
    } else {
      console.log(`[perf] PASS: p95 ${fmt(p95)} within SLO ${SLO_P95_MS}ms, full delivery`);
    }
  } finally {
    disconnectAll(receivers);
    // PERF_REUSE cleanup is a no-op (it never created the workspace); the
    // signup-bootstrap cleanup honours PERF_CLEANUP and logs its own outcome.
    await boot.cleanup();
  }

  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A graceful preflight stop (email gate / 4xx on the wrong stack) is not a
    // harness bug — print the actionable guidance and exit with the dedicated
    // code so callers can tell it apart from a real SLO breach (1).
    if (err instanceof PreflightStop) {
      console.error(`[perf] preflight stop: ${err.message}`);
      process.exit(err.exitCode);
    }
    console.error('[perf] setup/run error:', (err as Error).message);
    process.exit(1);
  });
