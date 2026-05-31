import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SEQ_SENTINEL } from '@qufox/shared-types';
import {
  ORIGIN,
  bearer,
  collectEvents,
  connectClient,
  seedRtStack,
  setupRtIntEnv,
  waitForEvent,
  type RtIntEnv,
} from './helpers';

/**
 * S10 (FR-RT-06): 서버가 채널 스코프 실시간 이벤트마다 채널별 단조 seq 를
 * 발행하는지 검증합니다. seq 는 Redis INCR seq:{channelId} 기반이며 갭 감지
 * 힌트 전용입니다(렌더 정렬은 id 기준 — 여기선 발행 여부/단조성만 확인).
 */
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
  await env.redis.del(`replay:channel:${stack.channelId}`);
  await env.redis.del(`seq:${stack.channelId}`);
});

describe('channel seq emission (FR-RT-06)', () => {
  it('message.created 가 채널별 단조 증가 seq 를 싣는다', async () => {
    const socketB = await connectClient(env.wsUrl, stack.member.accessToken);
    const collected = collectEvents<{ seq?: number; message: { content: string } }>(
      socketB,
      'message.created',
      2500,
    );

    for (let i = 0; i < 3; i++) {
      await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(stack.owner.accessToken))
        .send({ content: `seq #${i}` })
        .expect(201);
    }
    await env.dispatcher.drain();

    const events = await collected;
    expect(events.length).toBeGreaterThanOrEqual(3);
    const seqs = events.map((e) => e.seq);
    // 모든 seq 는 number 이며 sentinel 이 아님(정상 Redis).
    for (const s of seqs) {
      expect(typeof s).toBe('number');
      expect(s).not.toBe(SEQ_SENTINEL);
    }
    // 단조 증가(발행 순서대로 strictly increasing).
    const ordered = events
      .filter((e): e is { seq: number; message: { content: string } } => typeof e.seq === 'number')
      .map((e) => e.seq);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1]);
    }

    socketB.disconnect();
  });

  it('Redis seq 키가 발행 횟수만큼 증가한다', async () => {
    const socketB = await connectClient(env.wsUrl, stack.member.accessToken);
    for (let i = 0; i < 2; i++) {
      await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(stack.owner.accessToken))
        .send({ content: `incr #${i}` })
        .expect(201);
    }
    await env.dispatcher.drain();
    // INCR 가 비동기 emitAndBuffer 안에서 일어나므로 잠시 정착 대기.
    await new Promise((r) => setTimeout(r, 200));
    const raw = await env.redis.get(`seq:${stack.channelId}`);
    expect(Number(raw)).toBeGreaterThanOrEqual(2);
    socketB.disconnect();
  });
});

/**
 * S10 fix-forward (MAJOR #2): connect 시 채널별 seq baseline 스냅샷을
 * `channel:joined` 로 내려, 이번 세션에 라이브 메시지가 없던 채널도 클라
 * SeqTracker 에 등록되어 재연결 gap-fetch 대상이 되도록 합니다.
 */
describe('channel:joined seq baseline (FR-RT-06 fix-forward)', () => {
  it('connect 시 가입 채널마다 현재 seq 스냅샷을 channel:joined 로 emit', async () => {
    // 먼저 메시지 3개를 보내 채널 seq 를 키운다(라이브 클라 없이도 INCR 됨).
    const warm = await connectClient(env.wsUrl, stack.member.accessToken);
    for (let i = 0; i < 3; i++) {
      await request(env.baseUrl)
        .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
        .set('origin', ORIGIN)
        .set(bearer(stack.owner.accessToken))
        .send({ content: `baseline #${i}` })
        .expect(201);
    }
    await env.dispatcher.drain();
    await new Promise((r) => setTimeout(r, 200));
    warm.disconnect();

    // 새 연결: connect 직후 channel:joined 로 baseline 을 받아야 한다.
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    const joined = await new Promise<{ channelId: string; seq: number }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no channel:joined for target channel')), 4000);
      socket.on('channel:joined', (p: { channelId: string; seq: number }) => {
        if (p.channelId === stack.channelId) {
          clearTimeout(t);
          resolve(p);
        }
      });
    });
    expect(joined.channelId).toBe(stack.channelId);
    expect(typeof joined.seq).toBe('number');
    // seq 는 Redis 키 현재값과 일치(>=3, sentinel 아님).
    const raw = await env.redis.get(`seq:${stack.channelId}`);
    expect(joined.seq).toBe(Number(raw));
    expect(joined.seq).not.toBe(SEQ_SENTINEL);
    socket.disconnect();
  });

  it('connection:ready 이후 channel:joined 가 도착(순서 무회귀)', async () => {
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    // connection:ready 가 먼저, 곧이어 channel:joined.
    await waitForEvent(socket, 'connection:ready', 4000);
    const joined = await new Promise<{ channelId: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no channel:joined')), 4000);
      socket.on('channel:joined', (p: { channelId: string }) => {
        if (p.channelId === stack.channelId) {
          clearTimeout(t);
          resolve(p);
        }
      });
    });
    expect(joined.channelId).toBe(stack.channelId);
    socket.disconnect();
  });
});
