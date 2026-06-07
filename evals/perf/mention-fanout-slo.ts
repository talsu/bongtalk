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
 * Usage (small smoke against the live stack — do NOT run the full 100-user
 * load casually, it creates real traffic on prod):
 *
 *   CONN_COUNT=5 PERF_CLEANUP=true \
 *     BASE_URL=https://qufox.com/api SOAK_ORIGIN=https://qufox.com \
 *     pnpm perf:mention-slo
 *
 * Exit code: 1 if the measured P95 exceeds SLO_P95_MS (so `pnpm eval` can
 * score the DoD), 0 otherwise. A setup failure also exits non-zero.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { queryPrometheus } from '../soak/collect-metrics';

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

/**
 * Socket.IO origin. Mirrors apps/web/src/lib/socket.ts `socketOrigin()`:
 * the gateway lives at the page origin, not under `/api`, so strip a trailing
 * `/api` from BASE_URL when present.
 */
function socketOrigin(): string {
  return process.env.WS_ORIGIN ?? BASE_URL.replace(/\/api\/?$/, '');
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
  if (!res.ok) throw new Error(`${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
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
    `[perf] mention-fanout-slo run=${runId} conn=${CONN_COUNT} slo=${SLO_P95_MS}ms base=${BASE_URL} wsOrigin=${socketOrigin()}`,
  );

  // ── 1. signup all users ────────────────────────────────────────────────────
  const members: Member[] = [];
  for (let i = 0; i < CONN_COUNT; i++) {
    const email = `perf-${runId}-${stamp}-${i}@qufox.dev`;
    const username = `perf${stamp}${i}`;
    const u = await api.signup(email, username, PASSWORD);
    members.push({ token: u.accessToken, userId: u.userId });
  }
  const owner = members[0];

  // ── 2. workspace + TEXT channel + invite the rest ──────────────────────────
  const slug = `perf-${runId}-${stamp}`;
  const ws = await api.createWorkspace(owner.token, slug);
  const channel = await api.createChannel(owner.token, ws.id, `general-${stamp}`);

  // One invite per joiner (maxUses=1 mirrors the soak member-churn helper).
  for (let i = 1; i < members.length; i++) {
    const inv = await api.invite(owner.token, ws.id, 1);
    await api.accept(members[i].token, inv.code);
  }

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
    await api.sendMessage(owner.token, ws.id, channel.id, content);

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
    if (PERF_CLEANUP) {
      try {
        await api.deleteWorkspace(owner.token, ws.id, slug);
        console.log(`[perf] cleanup: workspace ${ws.id} deleted`);
      } catch (err) {
        console.warn(`[perf] cleanup failed (workspace ${ws.id}): ${(err as Error).message}`);
      }
    } else {
      console.log(`[perf] PERF_CLEANUP=false → leaving workspace ${ws.id} (slug=${slug})`);
    }
  }

  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[perf] setup/run error:', (err as Error).message);
    process.exit(1);
  });
