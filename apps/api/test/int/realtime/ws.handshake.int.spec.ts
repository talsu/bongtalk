import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, seedRtStack, setupRtIntEnv, type RtIntEnv } from './helpers';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe('WS handshake', () => {
  it('accepts a valid access token and joins workspace + channel rooms', async () => {
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  it('rejects a missing token with connect_error', async () => {
    await expect(connectClient(env.wsUrl, '')).rejects.toBeDefined();
  });

  it('rejects a tampered token', async () => {
    const bad = stack.member.accessToken.slice(0, -5) + 'XXXXX';
    await expect(connectClient(env.wsUrl, bad)).rejects.toBeDefined();
  });
});
