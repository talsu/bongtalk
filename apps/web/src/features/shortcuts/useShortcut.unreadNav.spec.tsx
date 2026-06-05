// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

/**
 * S82b (FR-KS-04 + FR-KS-11) spec:
 *  - Alt+Shift+↓ = 다음 미읽 채널로 이동, Alt+Shift+↑ = 이전 미읽 채널.
 *    미읽 0개면 no-op, 현재 채널이 미읽 목록에 없으면 첫 미읽로, wrap-around.
 *  - Ctrl/Cmd+N = 새 DM 진입점(/friends)으로 이동.
 *  - 기존 Alt+↑/↓(non-Shift) 채널 순회는 회귀 없이 보존(cross-fire 금지).
 *  - input 포커스 중에는 모든 단축키 무시.
 */

const navigate = vi.fn();
const setOpenModal = vi.fn();
let openModal: string | null = null;

// useParams 반환값을 테스트별로 갈아끼우기 위한 가변 핸들.
let params: { slug?: string; channelName?: string } = { slug: 'acme', channelName: 'general' };

// flat 순서: general → random → announce. id 와 name 매핑.
const channelList = {
  uncategorized: [
    { id: 'c-general', name: 'general', type: 'TEXT' },
    { id: 'c-random', name: 'random', type: 'TEXT' },
  ],
  categories: [
    {
      id: 'cat1',
      channels: [{ id: 'c-announce', name: 'announce', type: 'TEXT' }],
    },
  ],
};

// 미읽 요약. 테스트별로 교체.
let unreadSummary: { channels: { channelId: string; unreadCount: number }[] } = { channels: [] };

vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      setOpenModal,
      openModal,
      openSearchPanel: vi.fn(),
    }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => params,
}));

vi.mock('../workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [{ id: 'ws1', slug: 'acme' }] } }),
}));

vi.mock('../channels/useChannels', () => ({
  useChannelList: () => ({ data: channelList }),
}));

vi.mock('../channels/useUnread', () => ({
  useMarkAllRead: () => ({ mutate: vi.fn() }),
  useUnreadSummary: () => ({ data: unreadSummary }),
}));

import { useGlobalShortcuts } from './useShortcut';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  navigate.mockReset();
  setOpenModal.mockReset();
  openModal = null;
  params = { slug: 'acme', channelName: 'general' };
  unreadSummary = { channels: [] };
});

afterEach(() => cleanup());

function press(over: Partial<KeyboardEventInit>): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...over }));
}

describe('useGlobalShortcuts — unread channel navigation (S82b · FR-KS-04)', () => {
  it('Alt+Shift+↓ navigates to the next unread channel after the current one', () => {
    // random + announce 미읽, 현재는 general → 다음 미읽 = random.
    unreadSummary = {
      channels: [
        { channelId: 'c-random', unreadCount: 3 },
        { channelId: 'c-announce', unreadCount: 1 },
      ],
    };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(navigate).toHaveBeenCalledWith('/w/acme/random');
  });

  it('Alt+Shift+↑ navigates to the previous unread channel', () => {
    // 현재 = announce, 미읽 = general/random/announce → 이전 = random.
    params = { slug: 'acme', channelName: 'announce' };
    unreadSummary = {
      channels: [
        { channelId: 'c-general', unreadCount: 1 },
        { channelId: 'c-random', unreadCount: 2 },
        { channelId: 'c-announce', unreadCount: 4 },
      ],
    };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(navigate).toHaveBeenCalledWith('/w/acme/random');
  });

  it('wraps around: Alt+Shift+↓ from the last unread goes back to the first', () => {
    // 현재 = announce(마지막 미읽), 다음은 wrap → general.
    params = { slug: 'acme', channelName: 'announce' };
    unreadSummary = {
      channels: [
        { channelId: 'c-general', unreadCount: 1 },
        { channelId: 'c-announce', unreadCount: 4 },
      ],
    };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(navigate).toHaveBeenCalledWith('/w/acme/general');
  });

  it('no-op when there are no unread channels', () => {
    unreadSummary = { channels: [] };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores unread entries with zero count', () => {
    unreadSummary = {
      channels: [
        { channelId: 'c-random', unreadCount: 0 },
        { channelId: 'c-announce', unreadCount: 0 },
      ],
    };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('jumps to the first unread when the current channel is not unread', () => {
    // 현재 = general(읽음), 미읽 = random → 첫 미읽 = random.
    unreadSummary = { channels: [{ channelId: 'c-random', unreadCount: 5 }] };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(navigate).toHaveBeenCalledWith('/w/acme/random');
  });

  it('no-op outside a workspace (no slug)', () => {
    params = { slug: undefined, channelName: undefined };
    unreadSummary = { channels: [{ channelId: 'c-random', unreadCount: 5 }] };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores Alt+Shift navigation while an input is focused', () => {
    unreadSummary = { channels: [{ channelId: 'c-random', unreadCount: 5 }] };
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useGlobalShortcuts());
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'ArrowDown',
        altKey: true,
        shiftKey: true,
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('useGlobalShortcuts — Alt+↑/↓ regression (non-Shift, no cross-fire)', () => {
  it('Alt+↓ still cycles to the next channel in flat order (ignores unread)', () => {
    unreadSummary = { channels: [{ channelId: 'c-announce', unreadCount: 9 }] };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowDown', altKey: true });
    // 현재 general → flat 다음 = random (미읽 순회가 아니라 채널 순회).
    expect(navigate).toHaveBeenCalledWith('/w/acme/random');
  });

  it('Alt+↑ cycles to the previous channel in flat order', () => {
    params = { slug: 'acme', channelName: 'random' };
    renderHook(() => useGlobalShortcuts());
    press({ key: 'ArrowUp', altKey: true });
    expect(navigate).toHaveBeenCalledWith('/w/acme/general');
  });
});

describe('useGlobalShortcuts — Ctrl/Cmd+N new DM (S82b · FR-KS-11)', () => {
  it('Ctrl+N navigates to the friends list (new DM entry point)', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: 'n', ctrlKey: true });
    expect(navigate).toHaveBeenCalledWith('/friends');
  });

  it('Cmd+N navigates to the friends list', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: 'n', metaKey: true });
    expect(navigate).toHaveBeenCalledWith('/friends');
  });

  it('plain N (no modifier) does not navigate', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: 'n' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Ctrl+N is ignored while an input is focused', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useGlobalShortcuts());
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'n', ctrlKey: true }));
    expect(navigate).not.toHaveBeenCalled();
    input.remove();
  });
});
