import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { PushProcessor } from '../../../src/push/push.processor';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { PushService } from '../../../src/push/push.service';
import type { PushSendJobData } from '../../../src/push/push-queue.constants';

/**
 * S86 (FR-MN-15): PushProcessor 단위 — 잡 실행 시점 게이트 재평가(DND/mute/NotifLevel) +
 * read-check + sendToUser. web-push 전송은 PushService.sendToUser 스텁으로 격리한다.
 */

const baseData: PushSendJobData = {
  userId: 'user-1',
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  messageId: 'm-1',
  actorId: 'actor-1',
  snippet: 'hello there',
  everyone: false,
  here: false,
  actorName: 'Actor',
};

interface PrismaStubOverrides {
  user?: unknown;
  settings?: unknown;
  serverPref?: unknown;
  channelMute?: unknown;
  isRead?: boolean;
  // S86 리뷰 fix-forward (MEDIUM-2): null = 더는 워크스페이스 멤버 아님(skip).
  member?: unknown;
}

function makePrisma(o: PrismaStubOverrides = {}) {
  return {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          o.user === undefined
            ? { presencePreference: 'auto', dndSchedule: null, timezone: null }
            : o.user,
        ),
    },
    userSettings: {
      findUnique: vi.fn().mockResolvedValue(
        o.settings === undefined
          ? {
              notifTrigger: 'MENTIONS',
              dndUntil: null,
              dndSchedule: null,
              notifMobile: true,
              notifDesktop: true,
            }
          : o.settings,
      ),
    },
    serverNotificationPref: {
      findFirst: vi.fn().mockResolvedValue(o.serverPref ?? null),
    },
    userChannelMute: {
      findFirst: vi.fn().mockResolvedValue(o.channelMute ?? null),
    },
    // S86 리뷰 fix-forward (MEDIUM-2): 잡 시점 워크스페이스 멤버십 재검증. 기본은 멤버
    // 존재(기존 테스트 무회귀). member:null 로 비멤버(kick/leave) skip 분기 검증.
    workspaceMember: {
      findFirst: vi
        .fn()
        .mockResolvedValue(o.member === undefined ? { userId: 'user-1' } : o.member),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ is_read: o.isRead ?? false }]),
  };
}

function makeProcessor(prisma: ReturnType<typeof makePrisma>) {
  const sendToUser = vi.fn().mockResolvedValue(1);
  const push = { sendToUser } as unknown as PushService;
  const proc = new PushProcessor(prisma as unknown as PrismaService, push);
  return { proc, sendToUser };
}

function job(data: Partial<PushSendJobData> = {}): Job<PushSendJobData> {
  return { data: { ...baseData, ...data } } as unknown as Job<PushSendJobData>;
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('PushProcessor.process — 게이트 통과 시 전송', () => {
  it('기본(글로벌 MENTIONS·DND 없음·미읽음) 직접 멘션은 sendToUser 를 호출한다', async () => {
    const prisma = makePrisma();
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [uid, payload] = sendToUser.mock.calls[0];
    expect(uid).toBe('user-1');
    expect(payload).toMatchObject({ url: '/w/ws-1/c/ch-1' });
    expect((payload as { body: string }).body).toContain('hello');
  });
});

describe('PushProcessor.process — 게이트 skip', () => {
  it('notifMobile/notifDesktop 둘 다 OFF 면 skip', async () => {
    const prisma = makePrisma({
      settings: {
        notifTrigger: 'MENTIONS',
        dndUntil: null,
        dndSchedule: null,
        notifMobile: false,
        notifDesktop: false,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('잡 시점 워크스페이스 비멤버(kick/leave)면 skip (MEDIUM-2)', async () => {
    const prisma = makePrisma({ member: null });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('presencePreference=dnd 면 skip', async () => {
    const prisma = makePrisma({
      user: { presencePreference: 'dnd', dndSchedule: null, timezone: null },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('dndUntil 이 미래면(snooze 활성) skip', async () => {
    const prisma = makePrisma({
      settings: {
        notifTrigger: 'MENTIONS',
        dndUntil: new Date('2025-01-01T01:00:00Z'),
        dndSchedule: null,
        notifMobile: true,
        notifDesktop: true,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('글로벌 NotifLevel=NOTHING 이면 직접 멘션도 skip', async () => {
    const prisma = makePrisma({
      settings: {
        notifTrigger: 'NOTHING',
        dndUntil: null,
        dndSchedule: null,
        notifMobile: true,
        notifDesktop: true,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('서버 뮤트 활성이면 skip', async () => {
    const prisma = makePrisma({
      serverPref: {
        level: 'ALL',
        isMuted: true,
        muteUntil: null,
        suppressEveryone: false,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('채널 뮤트 활성이면 skip', async () => {
    const prisma = makePrisma({
      channelMute: { level: null, mutedUntil: null, isMuted: true },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('그 사이 메시지를 읽었으면(read-check) skip', async () => {
    const prisma = makePrisma({ isRead: true });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('계정 삭제(user 부재)면 skip', async () => {
    const prisma = makePrisma({ user: null });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });
});

describe('PushProcessor.process — S87 채널 per-device 산정(FR-MN-18)', () => {
  it('글로벌 둘 다 OFF·채널 오버라이드 없음 → effective 둘 다 false → skip(S86 무회귀)', async () => {
    const prisma = makePrisma({
      settings: {
        notifTrigger: 'MENTIONS',
        dndUntil: null,
        dndSchedule: null,
        notifMobile: false,
        notifDesktop: false,
      },
      // channelMute null → pushDesktop/pushMobile 폴백 null → global(false) 상속.
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('채널 pushMobile=false·pushDesktop=true → 전송하되 sendToUser 에 mobileEnabled=false 전달', async () => {
    const prisma = makePrisma({
      channelMute: {
        level: null,
        mutedUntil: null,
        isMuted: false,
        pushDesktop: true,
        pushMobile: false,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [, , opts] = sendToUser.mock.calls[0];
    expect(opts).toEqual({ desktopEnabled: true, mobileEnabled: false });
  });

  it('채널 push 둘 다 false → effective 둘 다 false → skip(글로벌이 ON 이어도 채널이 이김)', async () => {
    const prisma = makePrisma({
      channelMute: {
        level: null,
        mutedUntil: null,
        isMuted: false,
        pushDesktop: false,
        pushMobile: false,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('채널 pushDesktop=true 가 글로벌 notifDesktop=false 를 오버라이드(전송 + desktopEnabled=true)', async () => {
    const prisma = makePrisma({
      settings: {
        notifTrigger: 'MENTIONS',
        dndUntil: null,
        dndSchedule: null,
        notifMobile: false,
        notifDesktop: false,
      },
      channelMute: {
        level: null,
        mutedUntil: null,
        isMuted: false,
        pushDesktop: true,
        pushMobile: null,
      },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [, , opts] = sendToUser.mock.calls[0];
    // pushMobile=null → 글로벌 notifMobile=false 상속. pushDesktop=true 오버라이드.
    expect(opts).toEqual({ desktopEnabled: true, mobileEnabled: false });
  });

  it('기본(채널/글로벌 모두 ON·오버라이드 없음) → sendToUser opts 둘 다 true', async () => {
    const prisma = makePrisma();
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job());
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [, , opts] = sendToUser.mock.calls[0];
    expect(opts).toEqual({ desktopEnabled: true, mobileEnabled: true });
  });
});

describe('PushProcessor.process — broad(@everyone) suppressEveryone', () => {
  it('MENTIONS + suppressEveryone 이면 @everyone 멘션은 skip', async () => {
    const prisma = makePrisma({
      serverPref: { level: null, isMuted: false, muteUntil: null, suppressEveryone: true },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job({ everyone: true }));
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('MENTIONS + suppressEveryone=false 면 @everyone 멘션은 전송', async () => {
    const prisma = makePrisma({
      serverPref: { level: null, isMuted: false, muteUntil: null, suppressEveryone: false },
    });
    const { proc, sendToUser } = makeProcessor(prisma);
    await proc.process(job({ everyone: true }));
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });
});
