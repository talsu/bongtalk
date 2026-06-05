// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

/**
 * S82a (FR-KS-01) 회귀 가드: Cmd/Ctrl+K 가 신규 퀵스위처('quick-switcher')를
 * 열고, 기존 액션 팰릿(CommandPalette)은 Cmd/Ctrl+Shift+K 로 재바인딩돼 보존됨을
 * 검증한다. 두 단축키가 서로를 가로채지 않아야 한다.
 */

const setOpenModal = vi.fn();
let openModal: string | null = null;
vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      setOpenModal,
      openModal,
      openSearchPanel: vi.fn(),
    }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ slug: 'acme', channelName: undefined }),
}));

vi.mock('../workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [{ id: 'ws1', slug: 'acme' }] } }),
}));

vi.mock('../channels/useChannels', () => ({
  useChannelList: () => ({ data: { uncategorized: [], categories: [] } }),
}));

vi.mock('../channels/useUnread', () => ({
  useMarkAllRead: () => ({ mutate: vi.fn() }),
}));

import { useGlobalShortcuts } from './useShortcut';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  setOpenModal.mockReset();
  openModal = null;
});

afterEach(() => cleanup());

function press(over: Partial<KeyboardEventInit>): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...over }));
}

describe('useGlobalShortcuts — Cmd+K rebinding (S82a)', () => {
  it('Ctrl/Cmd+K opens the quick switcher', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: 'k', metaKey: true });
    expect(setOpenModal).toHaveBeenCalledWith('quick-switcher');
  });

  it('Ctrl/Cmd+Shift+K opens the action command palette (preserved)', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: 'k', metaKey: true, shiftKey: true });
    expect(setOpenModal).toHaveBeenCalledWith('command-palette');
  });

  it('Ctrl/Cmd+K does NOT open the command palette (no cross-fire)', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: 'k', ctrlKey: true });
    expect(setOpenModal).not.toHaveBeenCalledWith('command-palette');
    expect(setOpenModal).toHaveBeenCalledWith('quick-switcher');
  });

  it('Ctrl/Cmd+K toggles the quick switcher closed when already open', () => {
    openModal = 'quick-switcher';
    renderHook(() => useGlobalShortcuts());
    press({ key: 'k', metaKey: true });
    expect(setOpenModal).toHaveBeenCalledWith(null);
  });
});
