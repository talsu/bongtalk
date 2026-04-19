import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, setupMsgIntEnv } from '../messages/helpers';
import { MetricsService } from '../../../src/observability/metrics/metrics.service';

/**
 * Forces the outbox dispatcher into a stale state by rolling the
 * `outbox_last_dispatch_timestamp_seconds` gauge back into the past, then
 * asserts /readyz flips to 503.
 */
let env: MsgIntEnv;

beforeAll(async () => {
  env = await setupMsgIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe('/readyz degraded state', () => {
  it('returns 503 when outbox has not dispatched in > 10s', async () => {
    const metrics = env.app.get(MetricsService);
    // Set the gauge 60s in the past.
    metrics.outboxLastDispatchTimestampSeconds.set(Date.now() / 1000 - 60);

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
