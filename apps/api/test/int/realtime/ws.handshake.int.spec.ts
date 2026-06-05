import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  bearer,
  connectClient,
  ORIGIN,
  seedRtStack,
  setupRtIntEnv,
  signup,
  waitForEvent,
  type RtIntEnv,
} from './helpers';

let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

interface ReadyPayload {
  userId: string;
  sessionId: string;
  allWorkspaceMentionCounts?: Array<{ workspaceId: string; mentionCount: number }>;
}

describe('WS handshake', () => {
  it('accepts a valid access token and joins workspace + channel rooms', async () => {
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  it('emits connection:ready with {userId, sessionId} on connect (FR-RT-01)', async () => {
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    const ready = await waitForEvent<{ userId: string; sessionId: string }>(
      socket,
      'connection:ready',
      3000,
    );
    expect(ready.userId).toBe(stack.member.userId);
    expect(typeof ready.sessionId).toBe('string');
    expect(ready.sessionId.length).toBeGreaterThan(0);
    socket.disconnect();
  });

  // S69 fix-forward (reviewer MAJOR-1 · 뮤트 누수): connection:ready 의 멘션 카운트는
  // 뮤트-적용 배지 서비스(isMuted 채널/서버 제외)를 소스로 써야 한다. 멤버를 멘션한 뒤
  // 그 채널을 뮤트하면 재연결 시 allWorkspaceMentionCounts 가 0 이어야 한다(종전 unread
  // -totals 캐시 소스는 뮤트 미제외라 빨간 배지로 잘못 떴다).
  it('connection:ready 멘션 카운트는 뮤트한 채널의 멘션을 제외한다(MAJOR-1)', async () => {
    // 멘션 발생: owner 가 member 를 멘션(Message 행이 동기 기록됨 — 배지 서비스가 직접 조회).
    await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: `heads up @${stack.member.username}` })
      .expect(201);

    // 뮤트 전: member 의 connection:ready 멘션 카운트 >= 1.
    const s1 = await connectClient(env.wsUrl, stack.member.accessToken);
    const ready1 = await waitForEvent<ReadyPayload>(s1, 'connection:ready', 3000);
    s1.disconnect();
    const before = (ready1.allWorkspaceMentionCounts ?? []).find(
      (c) => c.workspaceId === stack.workspaceId,
    );
    expect(before?.mentionCount ?? 0).toBeGreaterThanOrEqual(1);

    // 채널 뮤트(영구 — 빈 바디).
    await request(env.baseUrl)
      .post(`/me/mutes/channels/${stack.channelId}`)
      .set('origin', ORIGIN)
      .set(bearer(stack.member.accessToken))
      .send({})
      .expect(200);

    // 뮤트 후: 재연결 시 멘션 카운트 0(뮤트 제외).
    const s2 = await connectClient(env.wsUrl, stack.member.accessToken);
    const ready2 = await waitForEvent<ReadyPayload>(s2, 'connection:ready', 3000);
    s2.disconnect();
    const after = (ready2.allWorkspaceMentionCounts ?? []).find(
      (c) => c.workspaceId === stack.workspaceId,
    );
    expect(after?.mentionCount ?? 0).toBe(0);
  });

  it('rejects a missing token with connect_error', async () => {
    await expect(connectClient(env.wsUrl, '')).rejects.toBeDefined();
  });

  it('rejects a tampered token', async () => {
    const bad = stack.member.accessToken.slice(0, -5) + 'XXXXX';
    await expect(connectClient(env.wsUrl, bad)).rejects.toBeDefined();
  });

  // S77c fix-forward (CF1 · reviewer B1 · perf MODERATE): 비활성 계정의 살아있는 access token 으로
  // 새 WS 재연결을 시도하면 핸드셰이크 이중검사(Redis 블랙리스트 + DB isDeactivated)가 connect_error
  // 로 거부해야 한다. 거부하지 못하면 fan-out/presence/typing 을 계속 수신한다(HTTP 만 막힘).
  describe('비활성 계정 WS 게이트 (CF1)', () => {
    it('Redis 블랙리스트 적중 시 동일 토큰 WS 연결을 connect_error 로 거부', async () => {
      const u = await signup(env.baseUrl, 'wsdeactr');
      // 연결 자체는 활성 상태에서 성공함을 먼저 확인(토큰 자체는 유효).
      const ok = await connectClient(env.wsUrl, u.accessToken);
      expect(ok.connected).toBe(true);
      ok.disconnect();

      // 비활성화 시뮬레이션: Redis 블랙리스트만 SET(즉시 차단 경로 — TTL 15m).
      await env.redis.set(`deactivated:${u.userId}`, '1', 'EX', 900);

      // 동일 토큰으로 재연결 → connect_error.
      await expect(connectClient(env.wsUrl, u.accessToken)).rejects.toBeDefined();
    });

    it('Redis 블랙리스트 만료 후에도 DB isDeactivated=true 면 WS 연결을 거부', async () => {
      const u = await signup(env.baseUrl, 'wsdeactd');
      // 블랙리스트는 없고(만료 가정) DB 컬럼만 비활성.
      await env.redis.del(`deactivated:${u.userId}`).catch(() => undefined);
      await env.prisma.user.update({
        where: { id: u.userId },
        data: { isDeactivated: true, deactivatedAt: new Date() },
      });

      await expect(connectClient(env.wsUrl, u.accessToken)).rejects.toBeDefined();
    });
  });
});
