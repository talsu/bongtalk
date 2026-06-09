import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { RealtimeGateway } from '../../../src/realtime/realtime.gateway';
import { OutboxToWsSubscriber } from '../../../src/realtime/projection/outbox-to-ws.subscriber';
import type { WsEnvelope } from '../../../src/realtime/events/ws-event-envelope';
import { rooms } from '../../../src/realtime/rooms/room-names';
import { connectReady, seedRtStack, setupRtIntEnv, type RtIntEnv } from './helpers';

/**
 * S105 (S99 보안 잔여): 공개 채널이 비공개로 전환되면, 더 이상 가시 멤버가 아닌
 * 소켓은 해당 채널 룸에서 실제로 leave 돼야 한다(IDOR 성 구독누수 차단).
 *
 * 종전엔 onChannelEvent 가 channel.created/deleted 에서만 refreshChannelIdsForWorkspace
 * 를 트리거해, channel.updated(isPrivate 공개→비공개)에는 룸 재조정 경로가 없었다.
 * S99 가 도입한 refreshUserChannelIds 의 toLeave 가 닫는 케이스이나, 그 트리거가
 * 빠져 있던 것을 S105 가 channel.updated 에도 refresh 를 걸어 메운다.
 */
let env: RtIntEnv;
let stack: Awaited<ReturnType<typeof seedRtStack>>;
let gateway: RealtimeGateway;
let subscriber: OutboxToWsSubscriber;

beforeAll(async () => {
  env = await setupRtIntEnv();
  stack = await seedRtStack(env.baseUrl);
  gateway = env.app.get(RealtimeGateway);
  subscriber = env.app.get(OutboxToWsSubscriber);
}, 300_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe('S105 채널 비공개 전환 시 비구성원 룸 leave (S99 보안 잔여)', () => {
  it('공개→비공개 전환 후 channel.updated refresh 가 가시성 잃은 멤버를 룸에서 leave', async () => {
    const channelId = stack.channelId;
    let socket: Socket | null = null;
    try {
      // member 는 워크스페이스 MEMBER → 공개 채널이 가시라 connect 시 채널 룸에 join.
      socket = await connectReady(env.wsUrl, stack.member.accessToken);
      const inBefore = await gateway.server.in(rooms.channel(channelId)).fetchSockets();
      // 전제: member 소켓이 채널 룸에 들어 있어야 테스트가 의미 있다.
      expect(inBefore.map((s) => s.id)).toContain(socket.id);

      // 채널을 비공개로 전환(member 는 override 가 없어 가시성 상실). prisma 직접
      // 변경으로 PATCH confirm 게이트/멘션 fanout 등 부수경로를 우회한다.
      await env.prisma.channel.update({
        where: { id: channelId },
        data: { isPrivate: true },
      });

      // channel.updated 이벤트가 subscriber 에 도달한 것과 동치인 onChannelEvent 호출.
      // (dispatcher 는 helper 에서 polling 일시정지 상태라 직접 invoke 한다.)
      await subscriber.onChannelEvent({
        type: 'channel.updated',
        workspaceId: stack.workspaceId,
        channelId,
        channel: { id: channelId },
      } as unknown as WsEnvelope);

      // 핵심 회귀: member 소켓이 비공개가 된 채널 룸에서 실제로 leave 됐다.
      const inAfter = await gateway.server.in(rooms.channel(channelId)).fetchSockets();
      expect(inAfter.map((s) => s.id)).not.toContain(socket.id);
    } finally {
      socket?.disconnect();
    }
  });
});
