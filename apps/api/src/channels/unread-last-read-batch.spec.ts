import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnreadService } from './unread.service';
import type { PrismaService } from '../prisma/prisma.module';

/**
 * S97 (FR-RT-22): getLastReadMessageIds 배치 조회 단위 테스트. realtime.gateway 가
 * connect 직후 channel:joined 스냅샷에 채널별 lastReadMessageId 를 싣기 위한
 * 출처다. ★핵심 불변식: per-channel 서브쿼리 폭주 없이 **단일 findMany(IN)** 1쿼리
 * 로 묶고, 누락 채널도 결정적으로 null 로 매핑한다(N+1 금지). 외부(Prisma)는
 * vi.fn() 으로만 모킹, 시간 고정.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeService(rows: Array<{ channelId: string; lastReadMessageId: string | null }>): {
  service: UnreadService;
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn(async () => rows);
  const prisma = {
    userChannelReadState: { findMany },
  } as unknown as PrismaService;
  return { service: new UnreadService(prisma), findMany };
}

describe('UnreadService.getLastReadMessageIds (FR-RT-22 배치)', () => {
  it('단일 findMany(IN) 1쿼리로 채널별 lastReadMessageId 를 Map 으로 반환(N+1 없음)', async () => {
    const { service, findMany } = makeService([
      { channelId: 'ch-1', lastReadMessageId: 'm-1' },
      { channelId: 'ch-2', lastReadMessageId: 'm-2' },
    ]);
    const map = await service.getLastReadMessageIds('u-1', ['ch-1', 'ch-2']);
    // ★ 정확히 1쿼리(채널 수와 무관 — 배치).
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', channelId: { in: ['ch-1', 'ch-2'] } },
      select: { channelId: true, lastReadMessageId: true },
    });
    expect(map.get('ch-1')).toBe('m-1');
    expect(map.get('ch-2')).toBe('m-2');
  });

  it('행 없는 채널은 결정적으로 null 로 매핑(키 존재 — 호출부 map.get(ch)?? null 안전)', async () => {
    const { service } = makeService([{ channelId: 'ch-1', lastReadMessageId: 'm-1' }]);
    const map = await service.getLastReadMessageIds('u-1', ['ch-1', 'ch-2', 'ch-3']);
    expect(map.get('ch-1')).toBe('m-1');
    expect(map.get('ch-2')).toBeNull();
    expect(map.get('ch-3')).toBeNull();
    expect(map.has('ch-2')).toBe(true);
  });

  it('read-state 행은 있으나 lastReadMessageId 가 null 이면 null 로 반환', async () => {
    const { service } = makeService([{ channelId: 'ch-1', lastReadMessageId: null }]);
    const map = await service.getLastReadMessageIds('u-1', ['ch-1']);
    expect(map.get('ch-1')).toBeNull();
  });

  it('빈 채널 목록은 쿼리 없이 빈 Map(불필요 쿼리 회피)', async () => {
    const { service, findMany } = makeService([]);
    const map = await service.getLastReadMessageIds('u-1', []);
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
