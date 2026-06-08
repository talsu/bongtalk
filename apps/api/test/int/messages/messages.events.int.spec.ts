import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MsgIntEnv, ORIGIN, bearer, seedMessageStack, setupMsgIntEnv } from './helpers';

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
  await env.prisma.outboxEvent.deleteMany({ where: { aggregateType: 'Message' } });
});

describe('Messages outbox events', () => {
  it('POST records message.created with the agreed envelope shape', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'hello outbox' });
    expect(post.status).toBe(201);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message' },
    });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.eventType).toBe('message.created');
    expect(e.aggregateId).toBe(post.body.message.id);
    expect(e.dispatchedAt).toBeNull();
    const payload = e.payload as unknown as {
      workspaceId: string;
      channelId: string;
      actorId: string;
      message: {
        id: string;
        content: string;
        contentRaw: string;
        contentAst: { type: string; nodes: unknown[] };
      };
    };
    expect(payload.workspaceId).toBe(stack.workspaceId);
    expect(payload.channelId).toBe(stack.channelId);
    expect(payload.actorId).toBe(stack.member.userId);
    expect(payload.message.content).toBe('hello outbox');
    // S02 (HIGH-S02-1): the WS create payload must carry the rich fields
    // the client cache inserts as a MessageDto, so live messages render
    // via renderAst rather than the regex fallback. Pin the contract.
    expect(payload.message.contentRaw).toBe('hello outbox');
    expect(payload.message.contentAst).toBeDefined();
    expect(payload.message.contentAst.type).toBe('root');
    expect(Array.isArray(payload.message.contentAst.nodes)).toBe(true);
  });

  it('dispatcher drain emits an envelope with id + type + occurredAt', async () => {
    const received: Array<{ id: string; type: string }> = [];
    const ee = env.app.get(EventEmitter2);
    const handler = (e: { id: string; type: string }) => received.push({ id: e.id, type: e.type });
    ee.on('message.created', handler);

    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'drain me' });
    expect(post.status).toBe(201);

    await env.dispatcher.drain();
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('message.created');
    const dispatched = await env.prisma.outboxEvent.findFirst({
      where: { aggregateType: 'Message' },
    });
    expect(dispatched?.dispatchedAt).not.toBeNull();
    expect(received[0].id).toBe(dispatched?.id);
    ee.off('message.created', handler);
  });

  it('PATCH edit records message.updated; DELETE records message.deleted', async () => {
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'orig' });
    const msgId = post.body.message.id;

    await request(env.baseUrl)
      .patch(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken))
      // S05 (FR-MSG-06): expectedVersion 은 required — 신규 메시지는 version 0.
      .send({ content: 'edited', expectedVersion: 0 })
      .expect(200);
    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages/${msgId}`)
      .set(bearer(stack.member.accessToken))
      .expect(204);

    const events = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message', aggregateId: msgId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'message.created',
      'message.updated',
      'message.deleted',
    ]);

    // S99 (S05-verify carryover · LOW): message.deleted 페이로드가 삭제 시점
    // version 을 동봉하는지 검증한다(수신 클라의 낙관적 잠금 baseline 갱신용).
    // 편집(version 0→1) 후 삭제이므로 soft-delete 는 version 을 올리지 않아
    // 마지막 편집의 version(1)이 그대로 실린다.
    const deletedEvent = events.find((e) => e.eventType === 'message.deleted');
    const deletedPayload = deletedEvent?.payload as {
      message?: { id?: string; deletedAt?: string; version?: number };
    };
    expect(deletedPayload?.message?.version).toBe(1);
    expect(typeof deletedPayload?.message?.deletedAt).toBe('string');
  });

  it('guard rejects BEFORE tx → no message.created outbox row (archived channel)', async () => {
    // ChannelAccessGuard returns CHANNEL_ARCHIVED before the send() tx opens,
    // so there is nothing to roll back — this asserts the pre-tx rejection
    // rather than genuine tx-abort behaviour. In-tx failure is exercised by
    // the idempotency 409 path in messages.idempotency.int.spec.ts.
    //
    // S44 fix-forward: 종전엔 archive 직후 aggregateType:'Message' outbox 가 0건이길
    // 단언했으나, S13(FR-CH-04)부터 archive 전환이 SYSTEM_CHANNEL_ARCHIVED 시스템
    // 메시지(aggregateType:'Message')를 발행하므로 그 단언은 stale 였다(이 슬라이스
    // 이전부터 깨져 있던 pre-existing 실패). 검증 의도("거부된 send 가 outbox 행을
    // 남기지 않는다")를 정확히 표현하도록, 거부된 send 의 message.created 가 없음을
    // 단언한다. archive 시스템 메시지는 정상 동작이라 허용한다.
    await env.prisma.outboxEvent.deleteMany({});
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/archive`)
      .set(bearer(stack.owner.accessToken))
      .expect(201);
    const post = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.member.accessToken))
      .send({ content: 'blocked' });
    expect(post.status).toBe(409);
    // 거부된 send 는 DEFAULT 메시지 outbox(message.created)를 남기지 않는다.
    const createdRows = await env.prisma.outboxEvent.findMany({
      where: { aggregateType: 'Message', eventType: 'message.created' },
    });
    const defaultCreated = createdRows.filter(
      (r) => (r.payload as { message?: { type?: string } }).message?.type === 'DEFAULT',
    );
    expect(defaultCreated).toHaveLength(0);
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/unarchive`)
      .set(bearer(stack.owner.accessToken));
  });
});
