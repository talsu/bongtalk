import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, setupMsgIntEnv } from '../messages/helpers';
import { MetricsService } from '../../../src/observability/metrics/metrics.service';
import { OutboxHealthIndicator } from '../../../src/health/outbox-health.indicator';

/**
 * Task-020-A: legacy degraded-state test updated for the new
 * idle-vs-stalled discriminator. Pre-020 the test drove stale by
 * rolling the last-dispatch gauge backwards; that now yields "idle"
 * (200) when the outbox is empty. Comprehensive 3-case coverage
 * lives in `outbox-health-idle-vs-stalled.int.spec.ts`; this file
 * keeps the narrow 019-era regression surface intact.
 */
let env: MsgIntEnv;

beforeAll(async () => {
  env = await setupMsgIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  await env.prisma.outboxEvent.deleteMany({ where: { aggregateType: 'Message' } });
  const metrics = env.app.get(MetricsService);
  metrics.outboxLastDispatchTimestampSeconds.set(0);
  env.app.get(OutboxHealthIndicator).invalidateCache();
});

describe('/readyz degraded state (task-020-A)', () => {
  it('returns 503 when an old undispatched row sits in the outbox and no tick fires', async () => {
    await env.prisma.outboxEvent.create({
      data: {
        aggregateType: 'Message',
        aggregateId: '00000000-0000-0000-0000-0000000000cc',
        eventType: 'message.created',
        payload: { stub: true },
        occurredAt: new Date(Date.now() - 60_000),
        dispatchedAt: null,
      },
    });

    const res = await request(env.baseUrl).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.outbox).toBe('stalled');
    expect(String(res.body.details?.outbox ?? '')).toMatch(/stalled/);
  });

  it('returns 200 when dispatcher has ticked recently', async () => {
    const metrics = env.app.get(MetricsService);
    metrics.outboxLastDispatchTimestampSeconds.set(Date.now() / 1000);
    const res = await request(env.baseUrl).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.outbox).toBe('ok');
  });
});
