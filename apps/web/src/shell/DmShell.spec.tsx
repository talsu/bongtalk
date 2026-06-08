// @vitest-environment jsdom
/**
 * FR-DM-15 — DmShell DM 사이드바 미읽/멘션 배지 + 뮤트 토글 회귀고정.
 *
 *  - 비뮤트 DM: unreadCount 를 배지로 표시.
 *  - 뮤트 DM: unread 억제 + @멘션 건수(mentionCount)만 배지로, bell-off + 회색.
 *  - 컨텍스트 메뉴(우클릭/⋯) 뮤트 → PATCH /me/dms/:id/mute {mutedUntil:null}.
 *  - 뮤트 DM 메뉴 "뮤트 해제" → DELETE /me/mutes/channels/:id.
 *  - mutation 성공 시 me/mutes 무효화 → 행 표시가 갱신된다.
 *
 * 네트워크는 lib/api 의 apiRequest 단일 경계만 vi.fn 으로 모킹한다(실제
 * useDmList/useMutes/useSetDmMute/useRemoveDmMute 동작). WS/Auth/무거운 자식
 * (WorkspaceNav/BottomBar/MessageColumn)은 가벼운 stub 으로 대체한다.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const apiRequest = vi.fn();
vi.mock('../lib/api', () => ({
  apiRequest: (path: string, opts?: unknown) => apiRequest(path, opts),
}));

vi.mock('../features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'me-1', username: 'me' } }),
}));
vi.mock('../features/workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [] } }),
}));
vi.mock('../features/notifications/useNotificationPreferences', () => ({
  useNotificationPreferences: () => undefined,
}));
vi.mock('../features/realtime/useDmPresence', () => ({
  useDmPresence: () => ({
    getStatus: () => 'offline',
    onlineUserIds: new Set<string>(),
    dndUserIds: new Set<string>(),
  }),
}));
vi.mock('../features/friends/useFriends', () => ({
  useFriendsList: () => ({ data: { items: [] } }),
}));
vi.mock('./WorkspaceNav', () => ({ WorkspaceNav: () => null }));
vi.mock('./BottomBar', () => ({ BottomBar: () => null }));
vi.mock('./MessageColumn', () => ({ MessageColumn: () => null }));

import { DmShell } from './DmShell';

const CH_PLAIN = '33333333-3333-4333-8333-333333333333'; // 비뮤트 (unread 4)
const CH_MUTED = '44444444-4444-4444-8444-444444444444'; // 뮤트 (unread 9 / mention 2)

type ApiState = {
  mutes: Array<{ channelId: string; mutedUntil: string | null }>;
};

function dmItem(
  channelId: string,
  otherUserId: string,
  otherUsername: string,
  unreadCount: number,
  mentionCount: number,
) {
  return {
    channelId,
    otherUserId,
    otherUsername,
    lastMessageAt: '2025-01-01T00:00:00.000Z',
    lastMessagePreview: 'hi',
    unreadCount,
    mentionCount,
    participants: [{ userId: otherUserId, username: otherUsername }],
  };
}

function installApi(state: ApiState): void {
  apiRequest.mockImplementation(
    async (path: string, opts?: { method?: string; body?: unknown }) => {
      const method = opts?.method ?? 'GET';
      if (path === '/me/dms') {
        return {
          items: [
            dmItem(CH_PLAIN, 'u-plain', 'alice', 4, 0),
            dmItem(CH_MUTED, 'u-muted', 'bob', 9, 2),
          ],
        };
      }
      if (path === '/me/mutes') return { items: state.mutes };
      // FR-DM-15: DM 뮤트 설정(무기한) — PATCH /me/dms/:id/mute {mutedUntil:null}.
      if (path.match(/^\/me\/dms\/.+\/mute$/) && method === 'PATCH') {
        const channelId = path.split('/')[3];
        state.mutes = [
          ...state.mutes.filter((m) => m.channelId !== channelId),
          { channelId, mutedUntil: null },
        ];
        return { channelId, mutedUntil: null };
      }
      // 뮤트 해제 — DELETE /me/mutes/channels/:id (카노니컬 unmute 재사용).
      if (path.startsWith('/me/mutes/channels/') && method === 'DELETE') {
        const channelId = path.split('/').pop() as string;
        state.mutes = state.mutes.filter((m) => m.channelId !== channelId);
        return undefined;
      }
      // by-user resolver(라우트 :userId 없을 땐 enabled=false 라 미호출이지만 안전).
      if (path.startsWith('/me/dms/by-user/')) return { channelId: null };
      throw new Error(`unexpected api call: ${method} ${path}`);
    },
  );
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/dm']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderShell(state: ApiState) {
  installApi(state);
  return render(<DmShell />, { wrapper: wrapper(newQc()) });
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  apiRequest.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('FR-DM-15 DmShell 배지', () => {
  it('비뮤트 DM 은 unreadCount(4)를 배지로 표시한다', async () => {
    renderShell({ mutes: [] });
    const badge = await screen.findByTestId('dm-shell-badge-alice');
    expect(badge.textContent).toBe('4');
  });

  it('뮤트 DM 은 unread 를 억제하고 @멘션 건수(2)만 배지로 표시 + bell-off + 회색', async () => {
    renderShell({ mutes: [{ channelId: CH_MUTED, mutedUntil: null }] });
    // 뮤트 행: 배지는 mentionCount(2), unread(9) 아님.
    const badge = await screen.findByTestId('dm-shell-badge-bob');
    expect(badge.textContent).toBe('2');
    // bell-off 표식 + 회색(data-muted).
    expect(screen.getByTestId('dm-shell-muted-bob')).toBeTruthy();
    expect(screen.getByTestId('dm-shell-row-bob').getAttribute('data-muted')).toBe('true');
  });

  it('뮤트 DM 인데 mentionCount=0 이면 배지를 숨긴다', async () => {
    // alice(비뮤트·unread 4)를 뮤트시키면 mentionCount=0 → 배지 없음.
    renderShell({ mutes: [{ channelId: CH_PLAIN, mutedUntil: null }] });
    await screen.findByTestId('dm-shell-row-alice');
    expect(screen.queryByTestId('dm-shell-badge-alice')).toBeNull();
    expect(screen.getByTestId('dm-shell-muted-alice')).toBeTruthy();
  });
});

describe('FR-DM-15 DmShell 뮤트 토글', () => {
  it('비뮤트 DM 컨텍스트 메뉴 "뮤트" → PATCH /me/dms/:id/mute {mutedUntil:null}', async () => {
    renderShell({ mutes: [] });
    await screen.findByTestId('dm-shell-row-alice');
    fireEvent.contextMenu(screen.getByTestId('dm-shell-row-alice'));
    fireEvent.click(await screen.findByTestId('dm-shell-mute-alice'));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        `/me/dms/${CH_PLAIN}/mute`,
        expect.objectContaining({ method: 'PATCH', body: { mutedUntil: null } }),
      );
    });
  });

  it('뮤트 DM 메뉴는 "뮤트 해제"를 노출하고 DELETE /me/mutes/channels/:id 를 호출 + 무효화 후 비뮤트로 갱신', async () => {
    const state: ApiState = { mutes: [{ channelId: CH_MUTED, mutedUntil: null }] };
    renderShell(state);
    await screen.findByTestId('dm-shell-row-bob');
    // 초기: bell-off 노출(뮤트).
    expect(screen.getByTestId('dm-shell-muted-bob')).toBeTruthy();

    fireEvent.contextMenu(screen.getByTestId('dm-shell-row-bob'));
    fireEvent.click(await screen.findByTestId('dm-shell-unmute-bob'));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        `/me/mutes/channels/${CH_MUTED}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    // me/mutes 무효화 → 재조회 시 뮤트 해제 상태(bell-off 사라지고 unread 배지로 전환).
    await waitFor(() => {
      expect(screen.queryByTestId('dm-shell-muted-bob')).toBeNull();
    });
    expect((await screen.findByTestId('dm-shell-badge-bob')).textContent).toBe('9');
  });
});
