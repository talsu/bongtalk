// @vitest-environment jsdom
/**
 * S43 (D02) — ChannelList 채널 마무리(FR-CH-14 카테고리 접기 / FR-CH-15 즐겨찾기 /
 * FR-CH-17 채널 뮤트 UI) 회귀고정.
 *
 * 모든 네트워크는 lib/api 의 apiRequest 단일 경계를 vi.fn 으로 모킹한다(외부
 * 모킹 라이브러리 금지). dnd-kit 의 실제 드래그는 jsdom 에서 재현이 어려우므로
 * 재정렬은 API 계약 테스트(int)로 별도 검증하고, 여기서는 토글/표시/저장/멘션
 * 유지 같은 결정적 UI 동작을 고정한다.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const apiRequest = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (path: string, opts?: unknown) => apiRequest(path, opts),
}));

import { ChannelList } from './ChannelList';

const WS = '11111111-1111-4111-8111-111111111111';
const CAT = '22222222-2222-4222-8222-222222222222';
const CH_GEN = '33333333-3333-4333-8333-333333333333'; // general (categorized)
const CH_RAND = '44444444-4444-4444-8444-444444444444'; // random (uncategorized)

function channel(id: string, name: string, categoryId: string | null) {
  return {
    id,
    workspaceId: WS,
    categoryId,
    name,
    type: 'TEXT' as const,
    topic: null,
    description: null,
    position: '1000',
    slowmodeSeconds: 0,
    isPrivate: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

type ApiState = {
  mutes: Array<{ channelId: string; mutedUntil: string | null }>;
  favorites: Array<{ channelId: string; position: string; createdAt: string }>;
};

function installApi(state: ApiState): void {
  apiRequest.mockImplementation(
    async (path: string, opts?: { method?: string; body?: unknown }) => {
      const method = opts?.method ?? 'GET';
      if (path === `/workspaces/${WS}/channels`) {
        return {
          categories: [
            {
              id: CAT,
              workspaceId: WS,
              name: '일반',
              description: null,
              position: '1000',
              createdAt: '2025-01-01T00:00:00.000Z',
              channels: [channel(CH_GEN, 'general', CAT)],
            },
          ],
          uncategorized: [channel(CH_RAND, 'random', null)],
        };
      }
      if (path === `/workspaces/${WS}/unread-summary`) {
        return {
          channels: [
            // general: unread + 멘션 2 (뮤트 검증용)
            {
              channelId: CH_GEN,
              unreadCount: 5,
              hasMention: true,
              mentionCount: 2,
              lastMessageAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        };
      }
      if (path === '/me/mutes') return { items: state.mutes };
      if (path === '/me/favorites') return { items: state.favorites };
      // S87 (FR-MN-18): ChannelList 가 채널 알림 모달의 상속 effective 표시용으로
      // 글로벌 push 설정을 조회한다. 이 회귀고정 스펙은 기본값(둘 다 true)으로 둔다.
      if (path === '/me/settings/notifications') {
        return {
          level: 'ALL',
          keywords: [],
          suppressDuringDnd: true,
          notifDesktop: true,
          notifMobile: true,
        };
      }
      // S85 (FR-CH-16): ChannelList 가 SidebarSections 를 렌더하면서 섹션 목록을
      // 조회한다. 이 S43 회귀고정 스펙은 섹션 없음(빈 배열)으로 둔다.
      if (path === `/workspaces/${WS}/sidebar-sections`) return { sections: [] };
      if (path.startsWith('/me/mutes/channels/')) {
        const channelId = path.split('/').pop() as string;
        if (method === 'POST') {
          const until = (opts?.body as { until?: string | null })?.until ?? null;
          state.mutes = [
            ...state.mutes.filter((m) => m.channelId !== channelId),
            { channelId, mutedUntil: until },
          ];
          return { channelId, mutedUntil: until, createdAt: '2025-01-01T00:00:00.000Z' };
        }
        if (method === 'DELETE') {
          state.mutes = state.mutes.filter((m) => m.channelId !== channelId);
          return undefined;
        }
      }
      if (path.match(/\/workspaces\/.+\/channels\/.+\/favorite$/)) {
        const channelId = path.split('/')[4];
        if (method === 'POST') {
          state.favorites = [
            ...state.favorites,
            { channelId, position: '1000', createdAt: '2025-01-01T00:00:00.000Z' },
          ];
          return { channelId, position: '1000', createdAt: '2025-01-01T00:00:00.000Z' };
        }
        if (method === 'DELETE') {
          state.favorites = state.favorites.filter((f) => f.channelId !== channelId);
          return undefined;
        }
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    },
  );
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderList(state: ApiState) {
  installApi(state);
  return render(
    <ChannelList workspaceId={WS} workspaceSlug="ws" canManage activeChannelName={null} />,
    { wrapper: wrapper(newQc()) },
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  window.localStorage.clear();
  apiRequest.mockReset();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('FR-CH-14 카테고리 접기/펼치기', () => {
  it('헤더 토글 버튼이 aria-expanded 를 갖고, 클릭 시 채널 숨김 + localStorage 저장', async () => {
    renderList({ mutes: [], favorites: [] });
    const toggle = await screen.findByTestId('category-collapse-일반');
    // 기본 펼침
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByTestId('channel-general')).toBeTruthy();

    fireEvent.click(toggle);
    // 접힘 → 채널 미렌더 + localStorage 정본 키에 "1"
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByTestId('channel-general')).toBeNull());
    expect(window.localStorage.getItem(`${WS}:category:${CAT}:collapsed`)).toBe('1');
  });

  it('localStorage 에 접힘이 저장돼 있으면 초기 렌더부터 접힘으로 복원', async () => {
    window.localStorage.setItem(`${WS}:category:${CAT}:collapsed`, '1');
    renderList({ mutes: [], favorites: [] });
    const toggle = await screen.findByTestId('category-collapse-일반');
    // 초기 렌더는 collapsedIds 가 비어 펼침으로 보였다가, 카테고리 로드 직후
    // effect 가 localStorage 를 읽어 접힘으로 정착한다(같은 data 로드 사이클).
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByTestId('channel-general')).toBeNull();
  });
});

describe('FR-CH-17 채널 뮤트 UI', () => {
  it('뮤트 채널은 회색(data-muted) + bell-off 아이콘 + 멘션 배지 유지', async () => {
    renderList({ mutes: [{ channelId: CH_GEN, mutedUntil: null }], favorites: [] });
    const row = await screen.findByTestId('channel-general');
    expect(row.getAttribute('data-muted')).toBe('true');
    // FR-RS-05: 뮤트는 unread 스타일 억제
    expect(row.getAttribute('data-unread')).toBe('false');
    // 멘션 배지는 유지(@멘션 2)
    expect(row.getAttribute('data-mention')).toBe('true');
    expect(screen.getByTestId('channel-muted-general')).toBeTruthy();
    expect(screen.getByLabelText('읽지 않은 멘션 2개')).toBeTruthy();
  });

  it('비뮤트 채널 메뉴에서 duration(1시간) 선택 → POST /me/mutes/channels {until=now+1h}', async () => {
    const state: ApiState = { mutes: [], favorites: [] };
    renderList(state);
    await screen.findByTestId('channel-general');
    fireEvent.contextMenu(screen.getByTestId('channel-general'));
    fireEvent.click(await screen.findByTestId('channel-mute-1h-general'));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        `/me/mutes/channels/${CH_GEN}`,
        expect.objectContaining({
          method: 'POST',
          body: { until: '2025-01-01T01:00:00.000Z' },
        }),
      );
    });
  });

  it('뮤트 채널 메뉴에는 "뮤트 해제"가 노출되고 DELETE 를 호출', async () => {
    const state: ApiState = { mutes: [{ channelId: CH_GEN, mutedUntil: null }], favorites: [] };
    renderList(state);
    await screen.findByTestId('channel-general');
    fireEvent.contextMenu(screen.getByTestId('channel-general'));
    fireEvent.click(await screen.findByTestId('channel-unmute-general'));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        `/me/mutes/channels/${CH_GEN}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});

describe('FR-CH-15 즐겨찾기', () => {
  it('비즐겨찾기 채널 메뉴는 "즐겨찾기 추가" → POST favorite 호출', async () => {
    const state: ApiState = { mutes: [], favorites: [] };
    renderList(state);
    await screen.findByTestId('channel-general');
    fireEvent.contextMenu(screen.getByTestId('channel-general'));
    const toggle = await screen.findByTestId('channel-favorite-toggle-general');
    expect(toggle.textContent).toBe('즐겨찾기 추가');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        `/workspaces/${WS}/channels/${CH_GEN}/favorite`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('즐겨찾기 채널은 최상단 Favorites 섹션에 렌더되고, 메뉴는 "즐겨찾기 해제"', async () => {
    const state: ApiState = {
      mutes: [],
      favorites: [{ channelId: CH_GEN, position: '1000', createdAt: '2025-01-01T00:00:00.000Z' }],
    };
    renderList(state);
    // 즐겨찾기 섹션 + 행
    expect(await screen.findByTestId('favorites-section')).toBeTruthy();
    expect(await screen.findByTestId('favorite-general')).toBeTruthy();
    // 채널 목록 메뉴는 해제 라벨
    fireEvent.contextMenu(screen.getByTestId('channel-general'));
    const toggle = await screen.findByTestId('channel-favorite-toggle-general');
    expect(toggle.textContent).toBe('즐겨찾기 해제');
  });

  it('즐겨찾기 0개면 Favorites 섹션을 렌더하지 않음', async () => {
    renderList({ mutes: [], favorites: [] });
    await screen.findByTestId('channel-general');
    expect(screen.queryByTestId('favorites-section')).toBeNull();
  });
});
