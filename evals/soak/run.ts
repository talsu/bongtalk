/**
 * Soak runner. Loops through scenarios until `--duration` elapses, then
 * queries Prometheus for SLO verdicts and writes a Markdown report.
 *
 * Usage:
 *   DURATION=15m BASE_URL=http://localhost:43001 \
 *     PROMETHEUS_URL=http://localhost:9090 \
 *     pnpm exec tsx evals/soak/run.ts
 *
 * When PROMETHEUS_URL is absent we still exercise the scenarios (traffic
 * only) but skip the SLO section of the report.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  channelChurn,
  makeWorld,
  memberChurn,
  steadyState,
  type Context,
  type Scenario,
} from './scenarios';
import { writeReport } from './report';
import { queryPrometheus } from './collect-metrics';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:43001';
const ORIGIN = process.env.SOAK_ORIGIN ?? 'http://localhost:45173';
const DURATION_MIN = Number(process.env.SOAK_DURATION_MINUTES ?? process.env.DURATION_MIN ?? 15);
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? null;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

function buildApi(): Context['api'] {
  return {
    async signup(email, username, password) {
      const r = await fetchJson<{ accessToken: string; user: { id: string } }>(
        `${BASE_URL}/auth/signup`,
        { method: 'POST', body: JSON.stringify({ email, username, password }) },
      );
      return { accessToken: r.accessToken, userId: r.user.id };
    },
    async login(email, password) {
      const r = await fetchJson<{ accessToken: string }>(`${BASE_URL}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      return { accessToken: r.accessToken };
    },
    async createWorkspace(token, slug) {
      const r = await fetchJson<{ id: string }>(`${BASE_URL}/workspaces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: `Soak ${slug}`, slug }),
      });
      return { id: r.id };
    },
    async createChannel(token, wsId, name) {
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
    async sendMessage(token, wsId, chId, content, idempotencyKey) {
      await fetchJson(`${BASE_URL}/workspaces/${wsId}/channels/${chId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ content }),
      });
    },
    async invite(token, wsId) {
      const r = await fetchJson<{ invite: { code: string } }>(
        `${BASE_URL}/workspaces/${wsId}/invites`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ maxUses: 1 }),
        },
      );
      return { code: r.invite.code };
    },
    async accept(token, code) {
      await fetchJson(`${BASE_URL}/invites/${code}/accept`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    },
    async removeMember(token, wsId, uid) {
      await fetch(`${BASE_URL}/workspaces/${wsId}/members/${uid}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      });
    },
  };
}

async function bootstrap(
  ctx: Context,
): ReturnType<typeof makeWorld> extends infer T ? Promise<T> : never {
  const world = makeWorld();
  const stamp = Date.now().toString(36);
  const password = 'Quanta-Beetle-Nebula-42!';
  const { accessToken, userId } = await ctx.api.signup(
    `soak-own-${ctx.runId}-${stamp}@qufox.dev`,
    `soakown${stamp}`,
    password,
  );
  world.owner = { token: accessToken, userId };
  const ws = await ctx.api.createWorkspace(accessToken, `soak-${ctx.runId}-${stamp}`);
  world.workspaceId = ws.id;
  const ch = await ctx.api.createChannel(accessToken, ws.id, `general-${stamp}`);
  world.channelId = ch.id;
  return world as never;
}

type Tally = { scenario: string; ok: number; err: number };

async function main(): Promise<void> {
  const runId = randomUUID().slice(0, 8);
  const ctx: Context = {
    baseUrl: BASE_URL,
    wsUrl: BASE_URL.replace('http', 'ws'),
    runId,
    api: buildApi(),
  };
  console.log(`[soak] runId=${runId} duration=${DURATION_MIN}m baseUrl=${BASE_URL}`);

  const world = await bootstrap(ctx);
  const scenarios: Scenario[] = [
    steadyState(world as never, 3_000),
    channelChurn(world as never, 60_000),
    memberChurn(world as never, 90_000),
  ];
  const tallies: Record<string, Tally> = Object.fromEntries(
    scenarios.map((s) => [s.name, { scenario: s.name, ok: 0, err: 0 }]),
  );

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_MIN * 60_000;
  const nextAt: Record<string, number> = Object.fromEntries(
    scenarios.map((s) => [s.name, startedAt]),
  );

  while (Date.now() < deadline) {
    for (const s of scenarios) {
      if (Date.now() >= nextAt[s.name]) {
        try {
          await s.run(ctx);
          tallies[s.name].ok += 1;
        } catch (e) {
          tallies[s.name].err += 1;
          console.warn(`[soak] ${s.name} err: ${(e as Error).message.slice(0, 160)}`);
        }
        nextAt[s.name] = Date.now() + s.everyMs;
      }
    }
    await sleep(500);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[soak] loop done in ${(elapsedMs / 1000).toFixed(1)}s`);

  const slo = PROMETHEUS_URL
    ? {
        http5xxRate: await queryPrometheus(
          PROMETHEUS_URL,
          'sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m]))',
        ),
        httpP95: await queryPrometheus(
          PROMETHEUS_URL,
          'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))',
        ),
        wsDisconnectRate: await queryPrometheus(
          PROMETHEUS_URL,
          'rate(ws_disconnections_total[5m])',
        ),
        outboxPending: await queryPrometheus(PROMETHEUS_URL, 'outbox_pending_events'),
      }
    : null;

  const report = writeReport({
    runId,
    startedAt,
    elapsedMs,
    tallies: Object.values(tallies),
    slo,
  });
  const out = join(process.cwd(), `soak-report-${runId}.md`);
  writeFileSync(out, report, 'utf8');
  console.log(`[soak] report → ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
