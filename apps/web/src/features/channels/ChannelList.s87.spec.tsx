// @vitest-environment jsdom
/**
 * S87 (FR-MN-18) — ChannelList per-channel 컨텍스트 메뉴에서 ChannelNotifSettings
 * (채널별 데스크톱/모바일 push 토글)가 도달 가능한지 회귀고정.
 *
 * 메뉴의 "알림 설정" 항목 → 별도 DS Dialog 로 ChannelNotifSettings 를 연다. 메뉴에
 * switch 를 직접 넣지 않아 기존 roving/typeahead 회귀를 피하는 배선이다. 네트워크는
 * lib/api 단일 경계 + useNotifLevels(글로벌/채널 pref) 훅을 vi.fn 으로 격리한다.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ChannelNotificationPreference } from '@qufox/shared-types';

const apiRequest = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (path: string, opts?: unknown) => apiRequest(path, opts),
}));

// notification-store 는 ChannelNotifSettings 의 toast push 만 쓰므로 no-op 스텁.
const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

// useNotifLevels: ChannelList 의 useGlobalNotificationSettings + ChannelNotifSettings 의
// useChannelNotificationPref/usePutChannelNotificationPref 를 함께 격리한다.
let channelPref: ChannelNotificationPreference;
const putChannelMutate = vi.fn();
vi.mock('../notifications/useNotifLevels', () => ({
  useGlobalNotificationSettings: () => ({
    data: {
      level: 'ALL',
      keywords: [],
      suppressDuringDnd: true,
      notifDesktop: true,
      notifMobile: false,
    },
  }),
  useChannelNotificationPref: () => ({ data: channelPref }),
  usePutChannelNotificationPref: () => ({ mutate: putChannelMutate, isPending: false }),
}));

import { ChannelList } from './ChannelList';

const WS = '11111111-1111-4111-8111-111111111111';
const CH_RAND = '44444444-4444-4444-8444-444444444444';

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

function installApi(): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === `/workspaces/${WS}/channels`) {
      return { categories: [], uncategorized: [channel(CH_RAND, 'random', null)] };
    }
    if (path === `/workspaces/${WS}/unread-summary`) return { channels: [] };
    if (path === '/me/mutes') return { items: [] };
    if (path === '/me/favorites') return { items: [] };
    if (path === `/workspaces/${WS}/sidebar-sections`) return { sections: [] };
    throw new Error(`unexpected api call: ${path}`);
  });
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

function renderList() {
  installApi();
  return render(
    <ChannelList workspaceId={WS} workspaceSlug="ws" canManage activeChannelName={null} />,
    { wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })) },
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  window.localStorage.clear();
  apiRequest.mockReset();
  putChannelMutate.mockReset();
  pushMock.mockReset();
  channelPref = {
    level: null,
    isMuted: false,
    muteUntil: null,
    pushDesktop: null,
    pushMobile: null,
  };
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('FR-MN-18 채널 메뉴 → 알림 설정 도달', () => {
  it('컨텍스트 메뉴에 "알림 설정" 항목이 있고, 선택 시 ChannelNotifSettings 모달이 열린다', async () => {
    renderList();
    await screen.findByTestId('channel-random');
    // 알림 설정 모달은 아직 닫혀 있다.
    expect(screen.queryByTestId('channel-notif-device-settings')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('channel-random'));
    const openItem = await screen.findByTestId('channel-notif-settings-open-random');
    expect(openItem.textContent).toBe('알림 설정');

    fireEvent.click(openItem);
    // 모달 안에 ChannelNotifSettings(채널 데스크톱/모바일 토글)이 렌더된다.
    expect(await screen.findByTestId('channel-notif-device-settings')).toBeTruthy();
    expect(screen.getByTestId('channel-pushDesktop-toggle')).toBeTruthy();
    expect(screen.getByTestId('channel-pushMobile-toggle')).toBeTruthy();
  });

  it('글로벌 effective 가 모달 스위치에 반영된다(상속: 데스크톱 on / 모바일 off)', async () => {
    renderList();
    await screen.findByTestId('channel-random');
    fireEvent.contextMenu(screen.getByTestId('channel-random'));
    fireEvent.click(await screen.findByTestId('channel-notif-settings-open-random'));
    await screen.findByTestId('channel-notif-device-settings');
    // 상속(null) 상태이므로 글로벌 effective(notifDesktop=true/notifMobile=false)가 반영된다.
    expect(screen.getByTestId('channel-pushDesktop-toggle').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('channel-pushMobile-toggle').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('모달에서 데스크톱 토글을 끄면 pushDesktop=false 로 PUT 한다', async () => {
    renderList();
    await screen.findByTestId('channel-random');
    fireEvent.contextMenu(screen.getByTestId('channel-random'));
    fireEvent.click(await screen.findByTestId('channel-notif-settings-open-random'));
    await screen.findByTestId('channel-notif-device-settings');
    fireEvent.click(screen.getByTestId('channel-pushDesktop-toggle'));
    expect(putChannelMutate).toHaveBeenCalledWith({ pushDesktop: false }, expect.anything());
  });
});
