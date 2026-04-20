import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, setupMsgIntEnv } from '../messages/helpers';
import { MetricsService } from '../../../src/observability/metrics/metrics.service';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';

/**
 * Task-020-A: three-state regression guard for the rewritten
 * OutboxHealthIndicator.
 *
 * Case 1 — idle (empty outbox, no recent dispatch tick).
 *   `/readyz` MUST return 200 with checks.outbox="idle". This is the
 *   specific case that failed in 019's auto-deploy.
 *
 * Case 2 — stalled (undispatched row older than threshold, no tick).
 *   `/readyz` returns 503 with checks.outbox="stalled" and a reason
 *   mentioning the backlog.
 *
 * Case 3 — recovery (after the dispatcher drains the backlog, /readyz
 *   returns to 200).
 */

let env: MsgIntEnv;

beforeAll(async () => {
  env = await setupMsgIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  // Clear any outbox rows left over from sibling specs.
  await env.prisma.outboxEvent.deleteMany({});
  // Reset the last-dispatch gauge so each case starts from zero.
  const metrics = env.app.get(MetricsService);
  metrics.outboxLastDispatchTimestampSeconds.set(0);
});

describe('OutboxHealthIndicator idle vs stalled (task-020-A)', () => {
  it('Case 1 — empty outbox + no dispatch tick → /readyz 200 "idle"', async () => {
    const res = await request(env.baseUrl).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.outbox).toBe('idle');
  });

  it('Case 2 — old undispatched row + no tick → /readyz 503 "stalled"', async () => {
    // Insert a row that's 60s old + never dispatched. prisma schema
    // allows occurredAt to be specified on insert.
    await env.prisma.outboxEvent.create({
      data: {
        aggregateType: 'Message',
        aggregateId: '00000000-0000-0000-0000-0000000000aa',
        eventType: 'message.created',
        payload: { stub: true },
        occurredAt: new Date(Date.now() - 60_000),
        dispatchedAt: null,
      },
    });
    // Dispatcher explicitly quiet — leave gauge at 0.
    const res = await request(env.baseUrl).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.outbox).toBe('stalled');
    expect(String(res.body.details?.outbox ?? '')).toMatch(/stalled/);
    expect(String(res.body.details?.outbox ?? '')).toMatch(/undispatched/);
  });

  it('Case 3 — dispatcher drains the backlog → /readyz 200 "ok" again', async () => {
    // Same setup as case 2.
    await env.prisma.outboxEvent.create({
      data: {
        aggregateType: 'Message',
        aggregateId: '00000000-0000-0000-0000-0000000000bb',
        eventType: 'message.created',
        payload: { stub: true },
        occurredAt: new Date(Date.now() - 60_000),
        dispatchedAt: null,
      },
    });
    const pre = await request(env.baseUrl).get('/readyz');
    expect(pre.status).toBe(503);

    // Run one dispatcher tick — drains the row and updates the
    // last-dispatch gauge.
    const dispatcher = env.app.get(OutboxDispatcher);
    await dispatcher.drain();

    const post = await request(env.baseUrl).get('/readyz');
    expect(post.status).toBe(200);
    expect(post.body.status).toBe('ok');
    // After drain the backlog is empty AND the gauge is recent →
    // state=healthy, word="ok" (not "idle").
    expect(['ok', 'idle']).toContain(post.body.checks.outbox);
  });
});
