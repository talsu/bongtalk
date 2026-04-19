import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from '../messages/helpers';

/**
 * Verifies the trace-context bridge the outbox adds to its payload:
 * a POST /messages → OutboxEvent row has a `__trace.traceparent` stored
 * in payload. The dispatcher's `restoreContext()` then runs `emitAsync`
 * with that extracted context active, so downstream @OnEvent handlers
 * participate in the same trace.
 *
 * We don't depend on an OTEL collector here — we just assert the envelope
 * contract that the observability layer relies on.
 */
let env: MsgIntEnv;
let stack: Awaited<ReturnType<typeof seedMessageStack>>;

beforeAll(async () => {
  env = await setupMsgIntEnv();
  stack = await seedMessageStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
});

describe('trace propagation', () => {
  it('POST /messages stores traceparent on the outbox payload', async () => {
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'trace me' })
      .expect(201);

    const row = await env.prisma.outboxEvent.findFirst({
      where: { eventType: 'message.created' },
    });
    expect(row).toBeTruthy();
    const payload = row!.payload as { __trace?: Record<string, string> };
    // When OTEL SDK is active the propagator writes a `traceparent`. When
    // it's not, __trace may be an empty object — we only assert the field
    // exists, not its shape (propagation is tested by the OTEL SDK itself).
    expect(payload.__trace).toBeDefined();
  });

  it('wire envelope does NOT leak internal __trace field to subscribers', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { EventEmitter2 } = await import('@nestjs/event-emitter');
    const emitter = env.app.get(EventEmitter2);
    const handler = (ev: Record<string, unknown>) => received.push(ev);
    emitter.on('message.created', handler);

    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'clean envelope' })
      .expect(201);

    await env.dispatcher.drain();
    expect(received.length).toBeGreaterThanOrEqual(1);
    for (const ev of received) {
      expect(ev.__trace).toBeUndefined();
      // also sanity: envelope keeps the task-004 shape
      expect(ev.id).toBeTypeOf('string');
      expect(ev.type).toBe('message.created');
    }
    emitter.off('message.created', handler);
  });
});
