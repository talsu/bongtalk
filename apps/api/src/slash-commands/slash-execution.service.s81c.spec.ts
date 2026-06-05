import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashExecutionService, substituteTemplateArgs } from './slash-execution.service';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S81c (D15 / FR-SC-09·10) 단위 테스트 — execute() 의 워크스페이스 커스텀 커맨드 분기.
 *
 * 외부(Prisma·도메인 서비스)는 vi.fn() 으로만 모킹한다. 빌트인에 없는 커맨드 →
 * 워크스페이스 커스텀 조회 → actionType 분기(EPHEMERAL_TEXT/SEND_TEMPLATE/REDIRECT_CHANNEL)·
 * 미존재 UNKNOWN·형식 위반 흡수·REDIRECT 접근 검증을 검증한다. ★외부 호출 분기 없음.
 * 시간 고정(2025-01-01). 결정적 uuid.
 */

const WS_ID = '11111111-1111-1111-1111-111111111111';
const CH_ID = '22222222-2222-2222-2222-222222222222';
const ME_ID = '33333333-3333-3333-3333-333333333333';
const TARGET_CH = '77777777-7777-7777-7777-777777777777';
const IDEM = '66666666-6666-6666-6666-666666666666';

type CustomRow = {
  actionType: string | null;
  actionParams: Record<string, unknown> | null;
} | null;

function makeService(opts?: { customRow?: CustomRow; hasPermission?: boolean }) {
  const slashFindFirst = vi.fn(async () => opts?.customRow ?? null);
  const send = vi.fn(async () => ({ message: { id: 'm-custom' } }));
  const hasPermission = vi.fn(async () => opts?.hasPermission ?? true);
  const channelFindFirst = vi.fn(async () => ({
    id: TARGET_CH,
    workspaceId: WS_ID,
    isPrivate: true,
  }));

  const prisma = {
    slashCommand: { findFirst: slashFindFirst },
    channel: { findFirst: channelFindFirst },
    user: { findMany: vi.fn(async () => []) },
    workspaceMember: { findMany: vi.fn(async () => []) },
  };

  const service = new SlashExecutionService(
    prisma as never,
    { send } as never,
    {} as never, // presence
    {} as never, // gateway
    {} as never, // status
    {} as never, // reminders
    {} as never, // channels
    { hasPermission } as never, // channelAccess
    {} as never, // directMessages
    {} as never, // memberProfile
    {} as never, // moderation
    {} as never, // mutes
    { search: vi.fn() } as never, // giphy
  );
  return { service, slashFindFirst, send, hasPermission, channelFindFirst };
}

function args(over: Partial<Parameters<SlashExecutionService['execute']>[0]>) {
  return {
    userId: ME_ID,
    workspaceId: WS_ID as string | null,
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

describe('execute() 커스텀 분기 — EPHEMERAL_TEXT', () => {
  it('actionParams.text 를 발신자 전용 EPHEMERAL 로 반환한다', async () => {
    const m = makeService({
      customRow: { actionType: 'EPHEMERAL_TEXT', actionParams: { text: '배포 가이드 링크' } },
    });
    const res = await m.service.execute(args({ command: 'guide' }));
    expect(m.slashFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS_ID, name: 'guide', enabled: true },
      }),
    );
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') {
      expect(res.content).toBe('배포 가이드 링크');
      expect(res.error).toBeUndefined();
    }
  });

  it('text 가 비면 형식 위반 EPHEMERAL error', async () => {
    const m = makeService({
      customRow: { actionType: 'EPHEMERAL_TEXT', actionParams: {} },
    });
    const res = await m.service.execute(args({ command: 'guide' }));
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('execute() 커스텀 분기 — SEND_TEMPLATE', () => {
  it('{args} 를 사용자 인자로 치환해 채널에 게시(IN_CHANNEL)', async () => {
    const m = makeService({
      customRow: { actionType: 'SEND_TEMPLATE', actionParams: { template: '공지: {args}' } },
    });
    const res = await m.service.execute(args({ command: 'announce', text: '점검 예정' }));
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '공지: 점검 예정', idempotencyKey: IDEM }),
    );
    expect(res.responseType).toBe('IN_CHANNEL');
    if (res.responseType === 'IN_CHANNEL') expect(res.messageId).toBe('m-custom');
  });

  it('치환 후 본문이 비면 EPHEMERAL error(미게시)', async () => {
    const m = makeService({
      customRow: { actionType: 'SEND_TEMPLATE', actionParams: { template: '{args}' } },
    });
    const res = await m.service.execute(args({ command: 'announce', text: '' }));
    expect(m.send).not.toHaveBeenCalled();
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });

  it('치환 후 본문이 MESSAGE 상한 초과면 EPHEMERAL error(미게시)', async () => {
    const m = makeService({
      customRow: { actionType: 'SEND_TEMPLATE', actionParams: { template: '{args}' } },
    });
    const res = await m.service.execute(args({ command: 'announce', text: 'x'.repeat(4001) }));
    expect(m.send).not.toHaveBeenCalled();
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('execute() 커스텀 분기 — REDIRECT_CHANNEL', () => {
  it('접근 가능한 채널이면 navigate(channel) 을 싣는다', async () => {
    const m = makeService({
      customRow: { actionType: 'REDIRECT_CHANNEL', actionParams: { channelId: TARGET_CH } },
      hasPermission: true,
    });
    const res = await m.service.execute(args({ command: 'go' }));
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') {
      expect(res.navigate).toEqual({ kind: 'channel', channelId: TARGET_CH });
      expect(res.error).toBeUndefined();
    }
  });

  it('접근 불가 채널이면 navigate 없이 EPHEMERAL error(IDOR 방지)', async () => {
    const m = makeService({
      customRow: { actionType: 'REDIRECT_CHANNEL', actionParams: { channelId: TARGET_CH } },
      hasPermission: false,
    });
    const res = await m.service.execute(args({ command: 'go' }));
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') {
      expect(res.navigate).toBeUndefined();
      expect(res.error).toBe(true);
    }
  });

  it('대상 채널이 없으면 EPHEMERAL error(존재 누출 없음)', async () => {
    const m = makeService({
      customRow: { actionType: 'REDIRECT_CHANNEL', actionParams: { channelId: TARGET_CH } },
    });
    m.channelFindFirst.mockResolvedValueOnce(null as never);
    const res = await m.service.execute(args({ command: 'go' }));
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
  });
});

describe('execute() 커스텀 분기 — 미존재 / DM', () => {
  it('빌트인에도 커스텀에도 없으면 SLASH_COMMAND_UNKNOWN', async () => {
    const m = makeService({ customRow: null });
    await expect(m.service.execute(args({ command: 'nope' }))).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_UNKNOWN,
    });
  });

  it('disabled 커스텀(enabled 필터로 조회 0건)도 SLASH_COMMAND_UNKNOWN', async () => {
    const m = makeService({ customRow: null });
    await expect(m.service.execute(args({ command: 'hidden' }))).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_UNKNOWN,
    });
  });

  it('DM(workspaceId=null)에서 커스텀(비빌트인) 커맨드는 SLASH_COMMAND_UNKNOWN(조회 안 함)', async () => {
    const m = makeService({ customRow: null });
    await expect(
      m.service.execute(args({ command: 'guide', workspaceId: null })),
    ).rejects.toMatchObject({ code: ErrorCode.SLASH_COMMAND_UNKNOWN });
    expect(m.slashFindFirst).not.toHaveBeenCalled();
  });

  it('actionType=null(빌트인 슬롯) 행은 실행하지 않고 UNKNOWN', async () => {
    const m = makeService({ customRow: { actionType: null, actionParams: null } });
    await expect(m.service.execute(args({ command: 'guide' }))).rejects.toMatchObject({
      code: ErrorCode.SLASH_COMMAND_UNKNOWN,
    });
  });
});

describe('substituteTemplateArgs', () => {
  it('{args} 토큰 전부를 인자로 치환한다', () => {
    expect(substituteTemplateArgs('{args} - {args}', '값')).toBe('값 - 값');
  });

  it('정규식 치환 패턴($1 등)이 인자에 있어도 리터럴로 들어간다', () => {
    expect(substituteTemplateArgs('x {args} y', '$1$&')).toBe('x $1$& y');
  });

  it('인자가 비면 {args} 는 빈 문자열로 치환(trim)', () => {
    expect(substituteTemplateArgs('  {args}  ', '   ')).toBe('');
  });

  it('{args} 가 없으면 템플릿 그대로(trim)', () => {
    expect(substituteTemplateArgs(' 고정 안내 ', '무시됨')).toBe('고정 안내');
  });
});
