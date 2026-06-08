import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeGateway } from './realtime.gateway';
import { rooms } from './rooms/room-names';

/**
 * S99 (S07 carryover · LOW): refreshUserChannelIds 의 join/leave 대칭 단위 검증.
 *
 * channel.created / member.joined fan-out 후 in-flight 소켓의 채널 룸 구독을
 * roomsForUser(cap=MAX_JOINED_CHANNELS 적용) 결과와 정합하게 맞추는지 본다.
 * 종전 버그: toJoin 만 처리하고 cap 밖으로 밀린 채널의 leave 를 계산/실행하지
 * 않아, 소켓이 옛 채널 룸에 남아 fanout 을 계속 받았다(cap 단조성 위반).
 */
describe('RealtimeGateway.refreshUserChannelIds', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  type SocketStub = {
    data: { state?: { channelIds: string[]; workspaceIds: string[] } };
    join: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
  };

  function makeGateway(args: {
    socket: SocketStub | null;
    fresh: { channelIds: string[]; workspaceIds: string[] };
  }): RealtimeGateway {
    const roomMgr = {
      roomsForUser: vi.fn(async () => ({
        rooms: [],
        workspaceIds: args.fresh.workspaceIds,
        channelIds: args.fresh.channelIds,
        temporaryWorkspaceIds: [],
      })),
    };
    // refreshUserChannelIds 는 roomMgr(arg #2)와 this.server 만 사용한다.
    // 나머지 생성자 의존성은 미사용이라 빈 스텁으로 채운다.
    const gw = new RealtimeGateway(
      {} as never, // wsAuth
      roomMgr as never, // roomMgr
      {} as never, // presence
      {} as never, // throttler
      {} as never, // graceTimers
      {} as never, // replay
      {} as never, // typing
      {} as never, // prisma
      {} as never, // seq
      {} as never, // unread
      {} as never, // badges
      {} as never, // tempEvict
    );
    const fetchSockets = vi.fn(async () => (args.socket ? [args.socket] : []));
    (gw as unknown as { server: unknown }).server = {
      in: vi.fn(() => ({ fetchSockets })),
    };
    return gw;
  }

  function makeSocket(channelIds: string[]): SocketStub {
    return {
      data: { state: { channelIds: [...channelIds], workspaceIds: ['w1'] } },
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
    };
  }

  it('toJoin: fresh 에만 있는 채널을 룸에 join', async () => {
    const socket = makeSocket(['c1', 'c2']);
    const gw = makeGateway({ socket, fresh: { channelIds: ['c1', 'c2', 'c3'], workspaceIds: ['w1'] } });
    await gw.refreshUserChannelIds('u1');
    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(socket.join).toHaveBeenCalledWith([rooms.channel('c3')]);
    expect(socket.leave).not.toHaveBeenCalled();
    expect(socket.data.state?.channelIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('toLeave: cap 밖으로 밀린(fresh 에 없는) 채널을 룸에서 leave', async () => {
    const socket = makeSocket(['c1', 'c2', 'c3']);
    // fresh 에서 c3 가 빠짐(cap 적용으로 밀림).
    const gw = makeGateway({ socket, fresh: { channelIds: ['c1', 'c2'], workspaceIds: ['w1'] } });
    await gw.refreshUserChannelIds('u1');
    expect(socket.join).not.toHaveBeenCalled();
    // leave 는 단건 호출(RemoteSocket.leave 는 배열 미지원).
    expect(socket.leave).toHaveBeenCalledTimes(1);
    expect(socket.leave).toHaveBeenCalledWith(rooms.channel('c3'));
    expect(socket.data.state?.channelIds).toEqual(['c1', 'c2']);
  });

  it('join + leave 동시: 추가 채널은 join, 밀려난 채널은 leave', async () => {
    const socket = makeSocket(['c1', 'old']);
    const gw = makeGateway({ socket, fresh: { channelIds: ['c1', 'new'], workspaceIds: ['w1'] } });
    await gw.refreshUserChannelIds('u1');
    expect(socket.join).toHaveBeenCalledWith([rooms.channel('new')]);
    expect(socket.leave).toHaveBeenCalledWith(rooms.channel('old'));
    expect(socket.leave).toHaveBeenCalledTimes(1);
    expect(socket.data.state?.channelIds).toEqual(['c1', 'new']);
  });

  it('변화 없음: join/leave 모두 미호출', async () => {
    const socket = makeSocket(['c1', 'c2']);
    const gw = makeGateway({ socket, fresh: { channelIds: ['c1', 'c2'], workspaceIds: ['w1'] } });
    await gw.refreshUserChannelIds('u1');
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('연결된 소켓 없음 → no-op (roomsForUser 미호출)', async () => {
    const gw = makeGateway({ socket: null, fresh: { channelIds: [], workspaceIds: [] } });
    await expect(gw.refreshUserChannelIds('u1')).resolves.toBeUndefined();
  });
});
