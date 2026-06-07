import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import { useNotifications } from '../../stores/notification-store';
import { qk } from '../../lib/query-keys';
import { applyEditConflict } from './useMessages';

/**
 * S05 (FR-MSG-06): 편집 낙관적 잠금 409 처리 검증.
 *
 * jsdom 없이(환경 node) 실제 react-query 머신을 `getMutationCache().build()`
 * 로 구동합니다 — useSendMessage.spec 과 동일 철학. mutationFn 이 409
 * (MESSAGE_VERSION_CONFLICT) + details.current(서버 최신 DTO)를 throw 했을 때:
 *   1. 캐시 행이 서버 최신 DTO 로 롤백된다.
 *   2. "다른 곳에서 수정되었습니다" 안내 토스트가 push 된다.
 *
 * reviewer MED-2: onError 분기를 복제하지 않고 useMessages 가 export 하는
 * `applyEditConflict` **소스 함수 그 자체**를 구동해 회귀 보호를 유지합니다.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  useNotifications.setState({ items: [] });
});

const WS = 'ws-1';
const CH = 'ch-1';

function makeDto(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'msg-x',
    channelId: CH,
    authorId: 'u-1',
    content: 'local edit',
    contentRaw: 'local edit',
    contentAst: null,
    contentPlain: 'local edit',
    type: 'DEFAULT',
    mentions: { users: [], channels: [], everyone: false, here: false, channel: false, roles: [] },
    edited: true,
    deleted: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    editedAt: '2025-01-01T00:00:00.000Z',
    reactions: [],
    parentMessageId: null,
    thread: null,
    attachments: [],
    pinnedAt: null,
    pinnedBy: null,
    version: 1,
    isBroadcast: false,
    parentExcerpt: null,
    threadLocked: false,
    embeds: [],
    ...overrides,
  };
}

describe('useUpdateMessage 409 conflict rollback (FR-MSG-06)', () => {
  it('rolls the cache row back to the server DTO + pushes a toast', async () => {
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    // 캐시에 사용자의 낙관적 로컬 편집 행이 들어있다(version=1, "local edit").
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(qk.messages.list(WS, CH), {
      pageParams: [undefined],
      pages: [
        {
          items: [makeDto({ content: 'local edit', version: 1 })],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      ],
    });
    // 서버 최신 DTO: 다른 곳에서 "server edit" 으로 편집됨, version=2.
    const serverCurrent = makeDto({ content: 'server edit', version: 2 });
    const mutationFn = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), {
        status: 409,
        errorCode: 'MESSAGE_VERSION_CONFLICT',
        details: { current: serverCurrent },
      });
    });
    const mutation = qc.getMutationCache().build(qc, {
      mutationFn,
      onError: (err) => {
        applyEditConflict(qc, WS, CH, err);
      },
    });
    try {
      await mutation.execute({});
    } catch {
      /* expected */
    }

    const data = qc.getQueryData(qk.messages.list(WS, CH)) as InfiniteData<ListMessagesResponse>;
    const row = data.pages[0].items[0];
    // 롤백: 캐시 행이 서버 최신값으로 교체.
    expect(row.content).toBe('server edit');
    expect(row.version).toBe(2);
    // 안내 토스트.
    const items = useNotifications.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].variant).toBe('danger');
    expect(items[0].body).toContain('다른 곳에서 수정되었습니다');
  });
});
