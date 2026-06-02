import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListEditHistoryResponse } from '@qufox/shared-types';

/**
 * S37 (FR-MSG-08): getEditHistory 는 워크스페이스 스코프 history 엔드포인트
 * (`/workspaces/:id/channels/:chid/messages/:msgId/history`)를 GET 하고 서버의
 * ListEditHistoryResponse(version desc, ≤10) 를 그대로 반환한다.
 */

const apiRequest = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const CH = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

describe('getEditHistory (FR-MSG-08)', () => {
  afterEach(() => apiRequest.mockReset());

  it('GET 으로 올바른 history 경로를 호출하고 응답을 그대로 반환한다', async () => {
    const { getEditHistory } = await import('./api');
    const resp: ListEditHistoryResponse = {
      items: [
        {
          version: 1,
          contentRaw: 'old',
          contentAst: null,
          contentPlain: 'old',
          editedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    };
    apiRequest.mockResolvedValueOnce(resp);

    const out = await getEditHistory(WS, CH, MSG);

    expect(out).toEqual(resp);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(String(apiRequest.mock.calls[0][0])).toBe(
      `/workspaces/${WS}/channels/${CH}/messages/${MSG}/history`,
    );
    // GET 이므로 method/body 옵션을 넘기지 않는다(기본 GET).
    expect(apiRequest.mock.calls[0][1]).toBeUndefined();
  });

  it('서버 403(MESSAGE_NOT_AUTHOR) 에러를 그대로 전파한다', async () => {
    const { getEditHistory } = await import('./api');
    const err = Object.assign(new Error('forbidden'), {
      errorCode: 'MESSAGE_NOT_AUTHOR',
      status: 403,
    });
    apiRequest.mockRejectedValueOnce(err);

    await expect(getEditHistory(WS, CH, MSG)).rejects.toMatchObject({
      errorCode: 'MESSAGE_NOT_AUTHOR',
    });
  });
});
