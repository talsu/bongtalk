import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { type Socket } from 'socket.io-client';
import { bearer, connectClient, seedRtStack, setupRtIntEnv, type RtIntEnv } from './helpers';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(async () => {
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.outboxEvent.deleteMany({});
});

function waitForDisconnect(socket: Socket, ms = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for disconnect')), ms);
    socket.once('disconnect', (reason: string) => {
      clearTimeout(t);
      resolve(reason);
    });
  });
}

describe('membership revocation', () => {
  it("removed member's socket disconnects and receives no further events", async () => {
    const memberSock = await connectClient(env.wsUrl, stack.member.accessToken);
    const disc = waitForDisconnect(memberSock, 10_000);

    await request(env.baseUrl)
      .delete(`/workspaces/${stack.workspaceId}/members/${stack.member.userId}`)
      .set(bearer(stack.owner.accessToken))
      .expect(204);

    await env.dispatcher.drain();

    const reason = await disc;
    expect(reason).toBeDefined();

    // Further events in the channel should not reach this socket (it's gone).
    const heard: string[] = [];
    memberSock.on('message.created', () => heard.push('bad'));
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'after kick' })
      .expect(201);
    await env.dispatcher.drain();
    await new Promise((r) => setTimeout(r, 200));
    expect(heard).toHaveLength(0);
  });
});
