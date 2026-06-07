import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushService, type WebPushSender } from '../../../src/push/push.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';

/**
 * S86 (FR-MN-15): PushService 단위 — VAPID no-op, sendToUser 전송, 410/404 stale GC,
 * 구독 upsert/remove userId 스코프. web-push HTTP 전송은 vi.fn() sender 로 격리한다.
 */
function makePrisma() {
  return {
    pushSubscription: {
      upsert: vi.fn().mockResolvedValue(undefined),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.useRealTimers();
});

describe('PushService.sendToUser — VAPID 미설정 graceful no-op', () => {
  it('VAPID env 부재 시 전송하지 않고 0 을 반환한다(findMany 도 호출 안 함)', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    const prisma = makePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);
    const sent = await svc.sendToUser('user-1', { title: 't', body: 'b' });
    expect(sent).toBe(0);
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });
});

describe('PushService.sendToUser — 전송 + stale GC', () => {
  function configuredService(prisma: ReturnType<typeof makePrisma>, sender: WebPushSender) {
    const svc = new PushService(prisma as unknown as PrismaService);
    svc.setWebPushSender(sender); // 주입 즉시 vapidConfigured=true
    return svc;
  }

  it('유효 구독 전부에 전송하고 성공 수를 반환한다', async () => {
    const prisma = makePrisma();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 's1', endpoint: 'https://push/1', p256dh: 'p1', auth: 'a1' },
      { id: 's2', endpoint: 'https://push/2', p256dh: 'p2', auth: 'a2' },
    ]);
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const svc = configuredService(prisma, sender);

    const sent = await svc.sendToUser('user-1', { title: 't', body: 'b', url: '/x' });

    expect(sent).toBe(2);
    expect(sender).toHaveBeenCalledTimes(2);
    // 페이로드는 JSON 직렬화돼 전송.
    const [, payloadStr] = sender.mock.calls[0];
    expect(JSON.parse(payloadStr as string)).toMatchObject({ title: 't', body: 'b', url: '/x' });
    // stale 없음 → deleteMany 호출 안 함.
    expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it('410/404 응답 endpoint 는 GC(deleteMany)로 삭제하고 그 구독은 전송 성공에서 제외', async () => {
    const prisma = makePrisma();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'gone', endpoint: 'https://push/gone', p256dh: 'p', auth: 'a' },
      { id: 'ok', endpoint: 'https://push/ok', p256dh: 'p', auth: 'a' },
    ]);
    const sender = vi.fn().mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/gone')) {
        return Promise.reject({ statusCode: 410 });
      }
      return Promise.resolve({ statusCode: 201 });
    });
    const svc = configuredService(prisma, sender);

    const sent = await svc.sendToUser('user-1', { title: 't', body: 'b' });

    expect(sent).toBe(1);
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['gone'] } },
    });
  });

  it('410/404 이 아닌 오류는 GC 하지 않고 전송 성공 수만 줄인다(비-치명)', async () => {
    const prisma = makePrisma();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 's1', endpoint: 'https://push/1', p256dh: 'p', auth: 'a' },
    ]);
    const sender = vi.fn().mockRejectedValue({ statusCode: 500 });
    const svc = configuredService(prisma, sender);

    const sent = await svc.sendToUser('user-1', { title: 't', body: 'b' });

    expect(sent).toBe(0);
    expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it('구독이 없으면 전송 시도 없이 0 을 반환한다', async () => {
    const prisma = makePrisma();
    prisma.pushSubscription.findMany.mockResolvedValue([]);
    const sender = vi.fn();
    const svc = configuredService(prisma, sender);
    const sent = await svc.sendToUser('user-1', { title: 't', body: 'b' });
    expect(sent).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });
});

describe('PushService.sendToUser — S87 per-device 게이트(FR-MN-18)', () => {
  function configuredService(prisma: ReturnType<typeof makePrisma>, sender: WebPushSender) {
    const svc = new PushService(prisma as unknown as PrismaService);
    svc.setWebPushSender(sender);
    return svc;
  }

  const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

  function twoDeviceSubs(prisma: ReturnType<typeof makePrisma>): void {
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'desk', endpoint: 'https://push/desk', p256dh: 'p', auth: 'a', ua: DESKTOP_UA },
      { id: 'mob', endpoint: 'https://push/mob', p256dh: 'p', auth: 'a', ua: MOBILE_UA },
    ]);
  }

  it('opts 미전달이면 전부 전송한다(S86 무회귀)', async () => {
    const prisma = makePrisma();
    twoDeviceSubs(prisma);
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const svc = configuredService(prisma, sender);
    const sent = await svc.sendToUser('user-1', { title: 't', body: 'b' });
    expect(sent).toBe(2);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('desktopEnabled=false 면 데스크톱 UA 구독은 미전송·모바일 UA 구독은 전송', async () => {
    const prisma = makePrisma();
    twoDeviceSubs(prisma);
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const svc = configuredService(prisma, sender);
    const sent = await svc.sendToUser(
      'user-1',
      { title: 't', body: 'b' },
      { desktopEnabled: false, mobileEnabled: true },
    );
    expect(sent).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
    const [sub] = sender.mock.calls[0];
    expect((sub as { endpoint: string }).endpoint).toBe('https://push/mob');
  });

  it('mobileEnabled=false 면 모바일 UA 구독은 미전송·데스크톱 UA 구독은 전송', async () => {
    const prisma = makePrisma();
    twoDeviceSubs(prisma);
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const svc = configuredService(prisma, sender);
    const sent = await svc.sendToUser(
      'user-1',
      { title: 't', body: 'b' },
      { desktopEnabled: true, mobileEnabled: false },
    );
    expect(sent).toBe(1);
    const [sub] = sender.mock.calls[0];
    expect((sub as { endpoint: string }).endpoint).toBe('https://push/desk');
  });

  it('ua 가 null 인 구독은 desktop 으로 분류(desktop OFF 면 미전송)', async () => {
    const prisma = makePrisma();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'unknown', endpoint: 'https://push/u', p256dh: 'p', auth: 'a', ua: null },
    ]);
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const svc = configuredService(prisma, sender);
    const sent = await svc.sendToUser(
      'user-1',
      { title: 't', body: 'b' },
      { desktopEnabled: false, mobileEnabled: true },
    );
    expect(sent).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });
});

describe('PushService.upsert/remove — userId 스코프', () => {
  it('upsert 는 endpoint 기준이며 userId/keys 를 함께 저장한다', async () => {
    const prisma = makePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);
    await svc.upsertSubscription(
      'user-1',
      { endpoint: 'https://push/e', keys: { p256dh: 'pp', auth: 'aa' } },
      'UA/1.0',
    );
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { endpoint: 'https://push/e' },
        create: expect.objectContaining({
          userId: 'user-1',
          p256dh: 'pp',
          auth: 'aa',
          ua: 'UA/1.0',
        }),
        update: expect.objectContaining({ userId: 'user-1', p256dh: 'pp', auth: 'aa' }),
      }),
    );
  });

  it('remove 는 userId + endpoint 동봉(deleteMany)으로 본인 구독만 삭제', async () => {
    const prisma = makePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);
    await svc.removeSubscription('user-1', 'https://push/e');
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', endpoint: 'https://push/e' },
    });
  });
});

describe('PushService.publicKey', () => {
  it('VAPID_PUBLIC_KEY 를 그대로 반환(미설정이면 빈 문자열)', () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const prisma = makePrisma();
    expect(new PushService(prisma as unknown as PrismaService).publicKey()).toBe('');
    process.env.VAPID_PUBLIC_KEY = 'BPubKey';
    expect(new PushService(prisma as unknown as PrismaService).publicKey()).toBe('BPubKey');
  });
});
