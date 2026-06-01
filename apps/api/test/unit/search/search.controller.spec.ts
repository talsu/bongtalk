import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchController } from '../../../src/search/search.controller';
import type { SearchService } from '../../../src/search/search.service';
import type { RateLimitService } from '../../../src/auth/services/rate-limit.service';

/**
 * task-046 iter3 (J3 carry-over): controller-level filter parsing 검증.
 *
 * 신규 query param: senderId / since / until / hasAttachment 가 service
 * 호출 args 로 정확히 매핑되는지, malformed 값이 VALIDATION_FAILED 로
 * 차단되는지 unit 으로 빠르게 cover.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const SENDER = '33333333-3333-4333-8333-333333333333';

function makeCtrl() {
  const search = {
    search: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    suggest: vi.fn().mockResolvedValue({ channels: [], users: [] }),
  } as unknown as SearchService;
  const rate = { enforce: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimitService;
  return { ctrl: new SearchController(search, rate), search, rate };
}

describe('SearchController.run filter params (task-046 J3)', () => {
  it('senderId / since / until / hasAttachment=true 모두 service args 에 매핑', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.run(
      { id: ME, email: 'me@e.com', username: 'me' },
      'hello',
      WS,
      undefined, // channelId
      undefined, // cursor
      '20', // limit
      SENDER, // senderId
      '2025-01-01T00:00:00Z', // since
      '2025-02-01T00:00:00Z', // until
      'true', // hasAttachment
      undefined, // sort
    );
    expect(search.search).toHaveBeenCalledTimes(1);
    const args = (search.search as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      query: string;
      workspaceId: string;
      userId: string;
      senderId?: string;
      since?: Date;
      until?: Date;
      hasAttachment?: boolean;
    };
    expect(args.query).toBe('hello');
    expect(args.workspaceId).toBe(WS);
    expect(args.userId).toBe(ME);
    expect(args.senderId).toBe(SENDER);
    expect(args.since instanceof Date).toBe(true);
    expect(args.until instanceof Date).toBe(true);
    expect(args.hasAttachment).toBe(true);
  });

  it('hasAttachment=false 도 정상 boolean false 로 매핑', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.run(
      { id: ME, email: 'me@e.com', username: 'me' },
      'hello',
      WS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'false',
      undefined,
    );
    const args = (search.search as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      hasAttachment?: boolean;
    };
    expect(args.hasAttachment).toBe(false);
  });

  it('hasAttachment 값이 임의의 문자열이면 undefined (filter 비활성)', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.run(
      { id: ME, email: 'me@e.com', username: 'me' },
      'hello',
      WS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'maybe',
      undefined,
    );
    const args = (search.search as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      hasAttachment?: boolean;
    };
    expect(args.hasAttachment).toBeUndefined();
  });

  it('since 가 ISO 가 아니면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        'hello',
        WS,
        undefined,
        undefined,
        undefined,
        undefined,
        'not-a-date',
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/invalid ISO date for since/);
  });

  it('since >= until 면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        'hello',
        WS,
        undefined,
        undefined,
        undefined,
        undefined,
        '2025-02-01T00:00:00Z',
        '2025-01-01T00:00:00Z',
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/since must be < until/);
  });

  it('아무 filter 도 안 줘도 정상 호출', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.run(
      { id: ME, email: 'me@e.com', username: 'me' },
      'hello',
      WS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const args = (search.search as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      senderId?: string;
      since?: Date;
      until?: Date;
      hasAttachment?: boolean;
    };
    expect(args.senderId).toBeUndefined();
    expect(args.since).toBeUndefined();
    expect(args.until).toBeUndefined();
    expect(args.hasAttachment).toBeUndefined();
  });

  it('S29 security: workspaceId 가 비-UUID 면 VALIDATION_FAILED (Prisma 500 누출 방지)', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        'hello',
        'not-a-uuid',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/workspaceId must be a valid UUID/);
  });

  it('S29 security: channelId 가 비-UUID 면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        'hello',
        WS,
        'bogus-channel', // channelId
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/channelId must be a valid UUID/);
  });

  it('S29 security: senderId 가 비-UUID 면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        'hello',
        WS,
        undefined,
        undefined,
        undefined,
        'bogus-sender', // senderId
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/senderId must be a valid UUID/);
  });

  it('S29 security: q 가 500자 초과면 VALIDATION_FAILED (DoS 풀스캔 방지)', async () => {
    const { ctrl } = makeCtrl();
    const huge = 'a'.repeat(501);
    await expect(
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        huge,
        WS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/q must be at most 500 characters/);
  });

  it('S29 security: q 가 정확히 500자면 통과(경계)', async () => {
    const { ctrl, search } = makeCtrl();
    const atCap = 'a'.repeat(500);
    await ctrl.run(
      { id: ME, email: 'me@e.com', username: 'me' },
      atCap,
      WS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it('S29: sort=recent 매핑, 미지정/임의는 relevance 로 degrade', async () => {
    const { ctrl, search } = makeCtrl();
    const call = (sortRaw: string | undefined) =>
      ctrl.run(
        { id: ME, email: 'me@e.com', username: 'me' },
        'hello',
        WS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sortRaw,
      );
    await call('recent');
    await call(undefined);
    await call('garbage');
    const calls = (search.search as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect((calls[0][0] as { sort?: string }).sort).toBe('recent');
    expect((calls[1][0] as { sort?: string }).sort).toBe('relevance');
    expect((calls[2][0] as { sort?: string }).sort).toBe('relevance');
  });
});

describe('SearchController.suggest (task-046 J1)', () => {
  it('q + workspaceId 가 있으면 service.suggest 호출', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, 'gen', WS, '5');
    expect(search.suggest).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: ME,
      prefix: 'gen',
      limit: 5,
    });
  });

  it('q 누락 → VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, undefined, WS, undefined),
    ).rejects.toThrow(/q is required/);
  });

  it('workspaceId 누락 → VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, 'gen', undefined, undefined),
    ).rejects.toThrow(/workspaceId is required/);
  });

  it('limit 미지정 시 기본 5', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, 'gen', WS, undefined);
    const args = (search.suggest as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { limit?: number };
    expect(args.limit).toBe(5);
  });

  it('limit > 20 은 20 으로 clamp', async () => {
    const { ctrl, search } = makeCtrl();
    await ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, 'gen', WS, '999');
    const args = (search.suggest as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { limit?: number };
    expect(args.limit).toBe(20);
  });

  it('S29 security: workspaceId 가 비-UUID 면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, 'gen', 'not-a-uuid', undefined),
    ).rejects.toThrow(/workspaceId must be a valid UUID/);
  });

  it('S29 security: q 가 500자 초과면 VALIDATION_FAILED', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.suggest({ id: ME, email: 'me@e.com', username: 'me' }, 'a'.repeat(501), WS, undefined),
    ).rejects.toThrow(/q must be at most 500 characters/);
  });
});
