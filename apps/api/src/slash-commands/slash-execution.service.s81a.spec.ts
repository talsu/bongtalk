import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashExecutionService } from './slash-execution.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S81a (D15 / FR-SC-08) 단위 테스트 — 서버 액션 슬래시 커맨드 분기.
 *
 * 외부(Prisma·도메인 서비스)는 vi.fn() 으로만 모킹한다(외부 모킹 라이브러리 금지).
 * 각 커맨드의 권한 성공/실패·대상 해석 실패·클라이언트 전용 NOT_EXECUTABLE 을 검증한다.
 * 시간 고정(2025-01-01). 채널/워크스페이스 id 는 결정적 uuid.
 */

const WS_ID = '11111111-1111-1111-1111-111111111111';
const CH_ID = '22222222-2222-2222-2222-222222222222';
const ME_ID = '33333333-3333-3333-3333-333333333333';
const TARGET_ID = '44444444-4444-4444-4444-444444444444';
const DM_ID = '55555555-5555-5555-5555-555555555555';
const IDEM = '66666666-6666-6666-6666-666666666666';

type Mocks = {
  service: SlashExecutionService;
  channelsUpdate: ReturnType<typeof vi.fn>;
  addOverride: ReturnType<typeof vi.fn>;
  hasPermission: ReturnType<typeof vi.fn>;
  createOrGetGlobal: ReturnType<typeof vi.fn>;
  updateProfile: ReturnType<typeof vi.fn>;
  kick: ReturnType<typeof vi.fn>;
  setMute: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  userFindMany: ReturnType<typeof vi.fn>;
};

function makeService(opts?: {
  hasPermission?: boolean;
  resolvedUsers?: Array<{ id: string; username: string }>;
}): Mocks {
  const hasPermissionVal = opts?.hasPermission ?? true;
  const resolvedUsers = opts?.resolvedUsers ?? [{ id: TARGET_ID, username: 'alice' }];

  const channelsUpdate = vi.fn(async () => ({ id: CH_ID }));
  const addOverride = vi.fn(async () => ({ id: 'ovr' }));
  const hasPermission = vi.fn(async () => hasPermissionVal);
  const createOrGetGlobal = vi.fn(async () => ({ channelId: DM_ID, created: true }));
  const updateProfile = vi.fn(async () => ({ nickname: 'nicky' }));
  const kick = vi.fn(async () => ({ undoToken: 't', undoExpiresAt: 'x' }));
  const setMute = vi.fn(async () => ({
    channelId: CH_ID,
    mutedUntil: null,
    createdAt: new Date(),
  }));
  const send = vi.fn(async () => ({ message: { id: 'm1' } }));
  // resolveMentionHandles 는 prisma.user.findMany 를 호출한다(username→id 맵). 채널 메타는
  // channel.findFirst 로 로드한다.
  const userFindMany = vi.fn(async () => resolvedUsers);

  const prisma = {
    user: { findMany: userFindMany },
    channel: {
      findFirst: vi.fn(async () => ({ id: CH_ID, workspaceId: WS_ID, isPrivate: false })),
    },
    workspaceMember: { findMany: vi.fn(async () => []) },
  };

  const service = new SlashExecutionService(
    prisma as never,
    { send } as never,
    {} as never, // presence
    {} as never, // gateway
    {} as never, // status
    {} as never, // reminders
    { update: channelsUpdate, addChannelMemberOverride: addOverride } as never,
    { hasPermission } as never,
    { createOrGetGlobal } as never,
    { updateProfile } as never,
    { kick } as never,
    { setMute } as never,
  );

  return {
    service,
    channelsUpdate,
    addOverride,
    hasPermission,
    createOrGetGlobal,
    updateProfile,
    kick,
    setMute,
    send,
    userFindMany,
  };
}

function args(over: Partial<Parameters<SlashExecutionService['execute']>[0]>) {
  return {
    userId: ME_ID,
    workspaceId: WS_ID,
    channelId: CH_ID,
    command: '',
    text: '',
    idempotencyKey: IDEM,
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  delete process.env.GIPHY_API_KEY;
});

describe('SlashExecutionService S81a — /nick', () => {
  it('닉네임을 설정하면 updateProfile(nickname) 을 호출하고 확인 EPHEMERAL', async () => {
    const m = makeService();
    const res = await m.service.execute(args({ command: 'nick', text: '냐옹이' }));
    expect(m.updateProfile).toHaveBeenCalledWith(WS_ID, ME_ID, { nickname: '냐옹이' });
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBeUndefined();
  });

  it('빈 인자는 닉네임을 null 로 지운다', async () => {
    const m = makeService();
    await m.service.execute(args({ command: 'nick', text: '' }));
    expect(m.updateProfile).toHaveBeenCalledWith(WS_ID, ME_ID, { nickname: null });
  });

  it('DM(workspaceId=null)이면 EPHEMERAL error(서비스 미호출)', async () => {
    const m = makeService();
    const res = await m.service.execute(args({ command: 'nick', workspaceId: null, text: 'x' }));
    expect(m.updateProfile).not.toHaveBeenCalled();
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('SlashExecutionService S81a — /topic', () => {
  it('MANAGE_CHANNEL 권한이 있으면 channels.update(topic) 호출', async () => {
    const m = makeService({ hasPermission: true });
    const res = await m.service.execute(args({ command: 'topic', text: '새 토픽' }));
    expect(m.channelsUpdate).toHaveBeenCalledWith(WS_ID, CH_ID, ME_ID, { topic: '새 토픽' });
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBeUndefined();
  });

  it('권한이 없으면 EPHEMERAL error 이고 update 미호출', async () => {
    const m = makeService({ hasPermission: false });
    const res = await m.service.execute(args({ command: 'topic', text: 'x' }));
    expect(m.channelsUpdate).not.toHaveBeenCalled();
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('SlashExecutionService S81a — /mute', () => {
  it('setMute(영구) 호출 + 확인 EPHEMERAL', async () => {
    const m = makeService();
    const res = await m.service.execute(args({ command: 'mute' }));
    expect(m.setMute).toHaveBeenCalledWith({ userId: ME_ID, channelId: CH_ID, mutedUntil: null });
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBeUndefined();
  });
});

describe('SlashExecutionService S81a — /kick', () => {
  it('@대상 해석 성공 시 moderation.kick 호출', async () => {
    const m = makeService({ resolvedUsers: [{ id: TARGET_ID, username: 'alice' }] });
    const res = await m.service.execute(args({ command: 'kick', text: '@alice' }));
    expect(m.kick).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      actorId: ME_ID,
      targetUserId: TARGET_ID,
    });
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBeUndefined();
  });

  it('대상 해석 실패(빈 결과) 시 EPHEMERAL error 이고 kick 미호출', async () => {
    const m = makeService({ resolvedUsers: [] });
    const res = await m.service.execute(args({ command: 'kick', text: '@ghost' }));
    expect(m.kick).not.toHaveBeenCalled();
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });

  it('도메인 권한 거부(kick throw)는 EPHEMERAL error 로 흡수', async () => {
    const m = makeService();
    m.kick.mockRejectedValueOnce(
      new DomainError(ErrorCode.WORKSPACE_INSUFFICIENT_ROLE, '권한 없음'),
    );
    const res = await m.service.execute(args({ command: 'kick', text: '@alice' }));
    if (res.responseType === 'EPHEMERAL') {
      expect(res.error).toBe(true);
      expect(res.content).toContain('권한');
    }
  });
});

describe('SlashExecutionService S81a — /invite', () => {
  it('권한 + 대상 해석 성공 시 addChannelMemberOverride(READ ALLOW) 호출', async () => {
    const m = makeService({ hasPermission: true });
    const res = await m.service.execute(args({ command: 'invite', text: '@alice' }));
    expect(m.addOverride).toHaveBeenCalledTimes(1);
    const callArgs = m.addOverride.mock.calls[0];
    expect(callArgs[0]).toBe(WS_ID);
    expect(callArgs[1]).toBe(CH_ID);
    expect(callArgs[2]).toBe(TARGET_ID);
    // allowMask 에 READ(0x01) 비트가 켜져 있어야 한다.
    expect((callArgs[3] as number) & 0x01).toBe(0x01);
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBeUndefined();
  });

  it('권한 없으면 EPHEMERAL error + addChannelMemberOverride 미호출', async () => {
    const m = makeService({ hasPermission: false });
    const res = await m.service.execute(args({ command: 'invite', text: '@alice' }));
    expect(m.addOverride).not.toHaveBeenCalled();
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('SlashExecutionService S81a — /msg', () => {
  it('@대상 + 본문이면 DM 개설 후 send + navigate 동봉', async () => {
    const m = makeService({ resolvedUsers: [{ id: TARGET_ID, username: 'alice' }] });
    const res = await m.service.execute(args({ command: 'msg', text: '@alice 안녕하세요' }));
    expect(m.createOrGetGlobal).toHaveBeenCalledWith(ME_ID, TARGET_ID);
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null, channelId: DM_ID, content: '안녕하세요' }),
    );
    if (res.responseType === 'EPHEMERAL') {
      expect(res.navigate).toEqual({ kind: 'dm', channelId: DM_ID, userId: TARGET_ID });
      expect(res.error).toBeUndefined();
    }
  });

  it('본문 없이 @대상만이면 DM 만 열고 send 미호출', async () => {
    const m = makeService({ resolvedUsers: [{ id: TARGET_ID, username: 'alice' }] });
    const res = await m.service.execute(args({ command: 'msg', text: '@alice' }));
    expect(m.createOrGetGlobal).toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    if (res.responseType === 'EPHEMERAL') expect(res.navigate?.channelId).toBe(DM_ID);
  });

  it('대상 해석 실패 시 EPHEMERAL error + DM 미개설', async () => {
    const m = makeService({ resolvedUsers: [] });
    const res = await m.service.execute(args({ command: 'msg', text: '@ghost hi' }));
    expect(m.createOrGetGlobal).not.toHaveBeenCalled();
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('SlashExecutionService S81a — 클라이언트 전용 커맨드', () => {
  for (const command of ['collapse', 'expand', 'search', 'shortcuts', 'darkmode']) {
    it(`/${command} 는 SLASH_COMMAND_NOT_EXECUTABLE 을 던진다(FE 가 가로챔)`, async () => {
      const m = makeService();
      await expect(m.service.execute(args({ command }))).rejects.toMatchObject({
        code: ErrorCode.SLASH_COMMAND_NOT_EXECUTABLE,
      });
    });
  }
});
