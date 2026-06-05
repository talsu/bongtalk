import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashExecutionService } from './slash-execution.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S81b (D15 / FR-SC-07) 단위 테스트 — /giphy 실행 분기(runGiphy).
 *
 * GiphyProxyService 는 vi.fn() 으로만 모킹한다(외부 모킹 라이브러리 금지). 시간 고정.
 * 키워드 유무·키 미설정 graceful·결과 없음·정상 프리뷰를 검증한다. GIPHY env-gate 는
 * GIPHY_API_KEY 로 빌트인 카탈로그 노출을 게이트하므로, 키가 설정된 환경을 가정한다.
 */

const WS_ID = '11111111-1111-1111-1111-111111111111';
const CH_ID = '22222222-2222-2222-2222-222222222222';
const ME_ID = '33333333-3333-3333-3333-333333333333';
const IDEM = '66666666-6666-6666-6666-666666666666';

function makeService(opts?: { giphySearch?: ReturnType<typeof vi.fn> }): {
  service: SlashExecutionService;
  giphySearch: ReturnType<typeof vi.fn>;
} {
  const giphySearch =
    opts?.giphySearch ??
    vi.fn(async () => ({
      gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      gifThumbUrl: 'https://media.giphy.com/media/abc/200w.gif',
      title: 'cat',
    }));

  const prisma = {
    user: { findMany: vi.fn(async () => []) },
    channel: { findFirst: vi.fn(async () => null) },
    workspaceMember: { findMany: vi.fn(async () => []) },
  };

  const service = new SlashExecutionService(
    prisma as never,
    { send: vi.fn() } as never, // messages
    {} as never, // presence
    {} as never, // gateway
    {} as never, // status
    {} as never, // reminders
    {} as never, // channels
    {} as never, // channelAccess
    {} as never, // directMessages
    {} as never, // memberProfile
    {} as never, // moderation
    {} as never, // mutes
    { search: giphySearch } as never, // giphy
  );
  return { service, giphySearch };
}

const baseArgs = {
  userId: ME_ID,
  workspaceId: WS_ID,
  channelId: CH_ID,
  command: 'giphy',
  idempotencyKey: IDEM,
  now: new Date('2025-01-01T00:00:00Z'),
};

describe('SlashExecutionService /giphy (S81b)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    process.env.GIPHY_API_KEY = 'test-key';
  });

  it('키워드가 있으면 GIPHY_PREVIEW 를 돌려준다(offset 0)', async () => {
    const { service, giphySearch } = makeService();
    const res = await service.execute({ ...baseArgs, text: 'cat' });
    expect(res.responseType).toBe('GIPHY_PREVIEW');
    if (res.responseType === 'GIPHY_PREVIEW') {
      expect(res.keyword).toBe('cat');
      expect(res.offset).toBe(0);
      expect(res.gifUrl).toContain('giphy.gif');
      expect(res.gifThumbUrl).toContain('200w.gif');
    }
    expect(giphySearch).toHaveBeenCalledWith('cat', 0);
  });

  it('키워드가 비면 검색하지 않고 EPHEMERAL 안내를 돌려준다', async () => {
    const { service, giphySearch } = makeService();
    const res = await service.execute({ ...baseArgs, text: '   ' });
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') expect(res.error).toBe(true);
    expect(giphySearch).not.toHaveBeenCalled();
  });

  it('결과가 없으면 EPHEMERAL 안내를 돌려준다(에러 아님)', async () => {
    const giphySearch = vi.fn(async () => null);
    const { service } = makeService({ giphySearch });
    const res = await service.execute({ ...baseArgs, text: 'zzzznope' });
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') {
      expect(res.content).toContain('GIF');
    }
  });

  it('GIPHY 키 미설정(GIPHY_UNAVAILABLE)은 graceful EPHEMERAL 로 흡수한다', async () => {
    const giphySearch = vi.fn(async () => {
      throw new DomainError(ErrorCode.GIPHY_UNAVAILABLE, 'GIPHY 가 설정되지 않았습니다');
    });
    const { service } = makeService({ giphySearch });
    const res = await service.execute({ ...baseArgs, text: 'cat' });
    expect(res.responseType).toBe('EPHEMERAL');
    if (res.responseType === 'EPHEMERAL') {
      expect(res.error).toBe(true);
      expect(res.content).toContain('GIPHY');
    }
  });
});
