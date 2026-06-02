import { beforeEach, describe, expect, it, vi } from 'vitest';
import { muteUntilFrom } from '../../../src/notifications/notif-preferences.service';
import { MuteExpiryCron } from '../../../src/notifications/mute-expiry.cron';

/**
 * S46 (D06 / FR-MN-08): 뮤트 기간 변환 + 만료 cron sweep 단위 검증.
 * 외부 모킹 라이브러리 금지 — vi.fn() 으로만 prisma 를 흉내낸다.
 */
beforeEach(() => {
  vi.setSystemTime('2025-01-01T00:00:00Z');
});

describe('muteUntilFrom — 기간 키 → 절대 종료 시각', () => {
  const now = new Date('2025-01-01T00:00:00Z');

  it("'forever'/미지정 → null(영구)", () => {
    expect(muteUntilFrom('forever', now)).toBeNull();
    expect(muteUntilFrom(undefined, now)).toBeNull();
  });

  it("'15m' → now + 15분", () => {
    expect(muteUntilFrom('15m', now)?.toISOString()).toBe('2025-01-01T00:15:00.000Z');
  });

  it("'1h' → now + 1시간", () => {
    expect(muteUntilFrom('1h', now)?.toISOString()).toBe('2025-01-01T01:00:00.000Z');
  });

  it("'8h' → now + 8시간", () => {
    expect(muteUntilFrom('8h', now)?.toISOString()).toBe('2025-01-01T08:00:00.000Z');
  });

  it("'24h' → now + 24시간", () => {
    expect(muteUntilFrom('24h', now)?.toISOString()).toBe('2025-01-02T00:00:00.000Z');
  });
});

describe('MuteExpiryCron.sweep — 만료 뮤트 해제', () => {
  it('server 업데이트 + channel 삭제(level null) + channel 뮤트해제(level 보존)를 분기 호출', async () => {
    const serverUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const channelDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const channelUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      serverNotificationPref: { updateMany: serverUpdateMany },
      userChannelMute: { deleteMany: channelDeleteMany, updateMany: channelUpdateMany },
    } as unknown as ConstructorParameters<typeof MuteExpiryCron>[0];

    const cron = new MuteExpiryCron(prisma);
    const now = new Date('2025-01-01T00:00:00Z');
    const res = await cron.sweep(now);

    expect(res).toEqual({ server: 2, channelCleared: 3, channelUnmuted: 1 });

    // server: 활성 뮤트(isMuted && muteUntil 과거) → isMuted=false, muteUntil=null.
    expect(serverUpdateMany).toHaveBeenCalledWith({
      where: { isMuted: true, muteUntil: { not: null, lt: now } },
      data: { isMuted: false, muteUntil: null },
    });
    // S46 fix-forward (BLOCKER 3): channel 만료 sweep 도 isMuted=true 술어로 좁힌다.
    // channel level=null(상속만) 만료 행 → 삭제.
    expect(channelDeleteMany).toHaveBeenCalledWith({
      where: { isMuted: true, mutedUntil: { not: null, lt: now }, level: null },
    });
    // channel level 보존 만료 행 → isMuted=false·mutedUntil=null 로 뮤트만 해제.
    expect(channelUpdateMany).toHaveBeenCalledWith({
      where: { isMuted: true, mutedUntil: { not: null, lt: now }, level: { not: null } },
      data: { isMuted: false, mutedUntil: null },
    });
  });
});
