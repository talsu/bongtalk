import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ORIGIN,
  bearer,
  connectClient,
  seedRtStack,
  setupRtIntEnv,
  type RtIntEnv,
} from './helpers';
import { UnreadService } from '../../../src/channels/unread.service';

/**
 * S97 (FR-RT-22): connect 직후 server 가 emit 하는 `channel:joined` 스냅샷에
 * 채널별 lastReadMessageId 가 동봉되는지 검증합니다. LRU evict 된 채널 재진입 시
 * 클라가 around=lastReadMessageId 로 재로드하는 seam 의 공급원입니다.
 *
 * 시나리오: 메시지를 보내고 그 id 로 read-state 를 ack(전진) → 재연결 시
 * channel:joined 가 그 lastReadMessageId 를 싣고 도착해야 합니다. read-state 가
 * 없는(아직 안 읽은) 채널은 lastReadMessageId=null 로 도착해야 합니다.
 *
 * 배치 N+1 가드: 가입 채널 수와 무관하게 server 는 단일 findMany(IN) 1쿼리로
 * 모든 채널 lastRead 를 묶습니다(getLastReadMessageIds 단위 spec 이 쿼리 형태를
 * 고정 — 여기선 wire 동봉만 확인).
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
  await env.prisma.userChannelReadState.deleteMany({ where: { channelId: stack.channelId } });
  await env.prisma.message.deleteMany({ where: { channelId: stack.channelId } });
});

function awaitChannelJoined(
  socket: Awaited<ReturnType<typeof connectClient>>,
  channelId: string,
): Promise<{ channelId: string; seq: number; lastReadMessageId?: string | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no channel:joined for target channel')), 4000);
    socket.on(
      'channel:joined',
      (p: { channelId: string; seq: number; lastReadMessageId?: string | null }) => {
        if (p.channelId === channelId) {
          clearTimeout(t);
          resolve(p);
        }
      },
    );
  });
}

describe('channel:joined lastReadMessageId snapshot (FR-RT-22)', () => {
  it('read-state ack 된 채널 재연결 시 그 lastReadMessageId 를 싣는다', async () => {
    // 메시지 1건을 보내 채널에 실재 messageId 를 만든다.
    const posted = await request(env.baseUrl)
      .post(`/workspaces/${stack.workspaceId}/channels/${stack.channelId}/messages`)
      .set('origin', ORIGIN)
      .set(bearer(stack.owner.accessToken))
      .send({ content: 'read me' })
      .expect(201);
    const messageId = posted.body.message.id as string;

    // member 의 read cursor 를 그 메시지로 전진(ack). UnreadService.ackRead 가
    // UserChannelReadState.lastReadMessageId 를 그 id 로 upsert 한다.
    const unread = env.app.get(UnreadService);
    await unread.ackRead({
      userId: stack.member.userId,
      channelId: stack.channelId,
      lastReadMessageId: messageId,
    });

    // 새 연결: connect 직후 channel:joined 가 그 lastReadMessageId 를 싣고 도착.
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    const joined = await awaitChannelJoined(socket, stack.channelId);
    expect(joined.channelId).toBe(stack.channelId);
    expect(joined.lastReadMessageId).toBe(messageId);
    socket.disconnect();
  });

  it('read-state 없는 채널은 lastReadMessageId=null 로 도착(과설계 방지·결정적)', async () => {
    // ack 없음 → read-state 행 없음.
    const socket = await connectClient(env.wsUrl, stack.member.accessToken);
    const joined = await awaitChannelJoined(socket, stack.channelId);
    expect(joined.channelId).toBe(stack.channelId);
    expect(joined.lastReadMessageId).toBeNull();
    socket.disconnect();
  });
});
