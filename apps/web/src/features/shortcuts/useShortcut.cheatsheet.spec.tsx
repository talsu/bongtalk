// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

/**
 * S83c (FR-KS-09) 회귀 가드: Ctrl/Cmd + / 가 단축키 치트시트('shortcut-help')를
 * 열도록 재바인딩됐음을 검증한다.
 *  - Ctrl/Cmd + / → setOpenModal('shortcut-help') (종전 검색 포커스 dispatch 폐지)
 *  - `?` 단독도 여전히 치트시트를 연다(중복 허용)
 *  - 검색 포커스 전용 단축키(qufox.search.focus)는 제거됐다 — Ctrl/Cmd+/ 가
 *    더 이상 그 이벤트를 dispatch 하지 않는다.
 */

const setOpenModal = vi.fn();
let openModal: string | null = null;
vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (_s: Record<string, unknown>) => unknown) =>
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
  useUnreadSummary: () => ({ data: { channels: [] } }),
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

describe('useGlobalShortcuts — Ctrl/Cmd+/ cheat sheet (S83c / FR-KS-09)', () => {
  it('Ctrl/Cmd + / opens the shortcut cheat sheet', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: '/', metaKey: true });
    expect(setOpenModal).toHaveBeenCalledWith('shortcut-help');
  });

  it('Ctrl/Cmd + / no longer dispatches the search-focus event (rebound)', () => {
    const onFocus = vi.fn();
    window.addEventListener('qufox.search.focus', onFocus);
    renderHook(() => useGlobalShortcuts());
    press({ key: '/', ctrlKey: true });
    window.removeEventListener('qufox.search.focus', onFocus);
    expect(onFocus).not.toHaveBeenCalled();
    expect(setOpenModal).toHaveBeenCalledWith('shortcut-help');
  });

  it('Ctrl/Cmd + / toggles the cheat sheet closed when already open', () => {
    openModal = 'shortcut-help';
    renderHook(() => useGlobalShortcuts());
    press({ key: '/', metaKey: true });
    expect(setOpenModal).toHaveBeenCalledWith(null);
  });

  it('`?` alone still opens the cheat sheet (preserved)', () => {
    renderHook(() => useGlobalShortcuts());
    press({ key: '?' });
    expect(setOpenModal).toHaveBeenCalledWith('shortcut-help');
  });
});
