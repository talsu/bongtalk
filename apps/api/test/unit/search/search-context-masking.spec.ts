import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { SearchService } from '../../../src/search/search.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { SearchResultRow } from '../../../src/search/search.service';

/**
 * S30 fix-forward 단위 테스트 — 검색 컨텍스트 권한 마스킹(BLOCKER A1 / HIGH A2).
 *
 * 통합 테스트는 정상 동작(컨텍스트 채널 == 결과 채널 → 항상 가시)만 타므로
 * ACL flip / 데이터 이상 edge 를 못 검증합니다. 여기서는 public 진입점
 * `searchWithContext` 를 호출하되, `search`(결과 한 줄)와 가시 채널 집합
 * (`visibleChannelIds`)을 통제해 다음을 직접 검증합니다.
 *
 *   (a) A1: 인접 메시지 채널이 가시 집합 밖이면 → messageId/createdAt/senderName/
 *           text 가 모두 null + masked:true (식별정보 0 placeholder).
 *   (b) A2: 스레드 루트 채널이 가시 집합 밖이면 → threadRootExcerpt=null
 *           (inThread 는 유지).
 */

const VISIBLE_CH = '11111111-1111-4111-8111-111111111111';
const HIDDEN_CH = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const ROOT = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/** 가시 채널 집합을 통제하는 SearchService 인스턴스 + Prisma 스텁 생성. */
function makeService(opts: {
  visible: string[];
  resultChannelId: string;
  neighbor?: {
    id: string;
    contentPlain: string;
    createdAt: Date;
    author: { username: string };
  } | null;
  parentMessageId?: string | null;
  root?: { contentPlain: string; deletedAt: Date | null; channelId: string } | null;
}): SearchService {
  const findFirst = vi.fn().mockResolvedValue(opts.neighbor ?? null);
  const findUnique = vi.fn(async (args: { where: { id: string }; select: unknown }) => {
    // threadRootExcerpt 는 답글 → 루트 순으로 두 번 findUnique 한다.
    if (args.where.id === MSG) return { parentMessageId: opts.parentMessageId ?? null };
    if (args.where.id === opts.parentMessageId) return opts.root ?? null;
    return null;
  });
  const prisma = {
    message: { findFirst, findUnique },
  } as unknown as PrismaService;
  const redis = {} as unknown as Redis;
  const service = new SearchService(prisma, redis);

  // search()(결과 한 줄) 와 visibleChannelIds(가시 집합)를 통제한다.
  const resultRow: SearchResultRow = {
    messageId: MSG,
    channelId: opts.resultChannelId,
    channelName: 'general',
    senderId: '55555555-5555-4555-8555-555555555555',
    senderName: 'alice',
    createdAt: '2025-01-01T00:00:00.000Z',
    snippet: 'hello <mark>needle</mark>',
    rank: 0.5,
  };
  vi.spyOn(service, 'search').mockResolvedValue({ results: [resultRow], nextCursor: null });
  // private visibleChannelIds 를 통제(타입 안전한 좁힘 캐스팅).
  const withPrivate = service as unknown as {
    visibleChannelIds: (workspaceId: string, userId: string) => Promise<string[]>;
  };
  vi.spyOn(withPrivate, 'visibleChannelIds').mockResolvedValue(opts.visible);
  return service;
}

const ARGS = {
  query: 'needle',
  workspaceId: '66666666-6666-4666-8666-666666666666',
  userId: '77777777-7777-4777-8777-777777777777',
  limit: 20,
};

describe('searchWithContext — A1 neighbor masking', () => {
  it('인접 메시지 채널이 가시 집합 밖이면 식별정보 0 + masked:true (쿼리도 스킵)', async () => {
    // 결과 채널 자체가 가시 집합 밖(ACL flip edge) → neighborMessage 가
    // findFirst 이전에 early-return 해야 한다.
    const service = makeService({
      visible: [], // 아무 채널도 가시 X
      resultChannelId: HIDDEN_CH,
      neighbor: {
        id: 'b1111111-1111-4111-8111-111111111111',
        contentPlain: 'leak me',
        createdAt: new Date('2024-12-31T23:59:00.000Z'),
        author: { username: 'bob' },
      },
    });
    const out = await service.searchWithContext(ARGS);
    const before = out.results[0].contextBefore;
    expect(before).toEqual({
      messageId: null,
      senderName: null,
      text: null,
      createdAt: null,
      masked: true,
    });
    // 가시 집합 밖이면 DB 를 조회하지 않아야 한다(불필요 쿼리 + 누출 0).
    const prismaFindFirst = (
      service as unknown as { prisma: { message: { findFirst: ReturnType<typeof vi.fn> } } }
    ).prisma.message.findFirst;
    expect(prismaFindFirst).not.toHaveBeenCalled();
  });

  it('가시 채널이면 인접 메시지를 조회해 masked:false 로 모든 필드 채움', async () => {
    const service = makeService({
      visible: [VISIBLE_CH],
      resultChannelId: VISIBLE_CH,
      neighbor: {
        id: 'b1111111-1111-4111-8111-111111111111',
        contentPlain: 'hello there',
        createdAt: new Date('2024-12-31T23:59:00.000Z'),
        author: { username: 'bob' },
      },
    });
    const out = await service.searchWithContext(ARGS);
    const before = out.results[0].contextBefore;
    expect(before?.masked).toBe(false);
    expect(before?.messageId).toBe('b1111111-1111-4111-8111-111111111111');
    expect(before?.senderName).toBe('bob');
    expect(before?.text).toContain('hello there');
    expect(before?.createdAt).toBe('2024-12-31T23:59:00.000Z');
  });
});

describe('searchWithContext — A2 thread root channel visibility', () => {
  it('루트 채널이 가시 집합 밖이면 excerpt=null + inThread:true', async () => {
    const service = makeService({
      visible: [VISIBLE_CH], // 결과 채널은 가시
      resultChannelId: VISIBLE_CH,
      neighbor: null,
      parentMessageId: ROOT,
      // 루트는 가시 집합에 없는 HIDDEN_CH 에 있음(데이터 이상/멀티레벨 edge).
      root: { contentPlain: 'secret root body', deletedAt: null, channelId: HIDDEN_CH },
    });
    const out = await service.searchWithContext(ARGS);
    expect(out.results[0].inThread).toBe(true);
    expect(out.results[0].threadRootExcerpt).toBeNull();
  });

  it('루트 채널이 가시 집합 안이면 excerpt 를 채움', async () => {
    const service = makeService({
      visible: [VISIBLE_CH],
      resultChannelId: VISIBLE_CH,
      neighbor: null,
      parentMessageId: ROOT,
      root: { contentPlain: 'visible root body', deletedAt: null, channelId: VISIBLE_CH },
    });
    const out = await service.searchWithContext(ARGS);
    expect(out.results[0].inThread).toBe(true);
    expect(out.results[0].threadRootExcerpt).toContain('visible root body');
  });
});
