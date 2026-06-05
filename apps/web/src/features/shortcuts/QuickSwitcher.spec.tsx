// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { MemberWithPresence } from '@qufox/shared-types';

// ── 모킹 (모든 데이터는 기존 훅에서 — 단위 테스트는 훅을 스텁한다) ───────────

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ slug: paramSlug }),
}));

let openModal: string | null = 'quick-switcher';
const setOpenModal = vi.fn();
vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (s: { openModal: string | null; setOpenModal: typeof setOpenModal }) => unknown) =>
    sel({ openModal, setOpenModal }),
}));

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'me' } }),
}));

vi.mock('../workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [{ id: 'ws1', slug: 'acme' }] } }),
  useMembers: () => ({ data: { members: membersData } }),
}));

vi.mock('../channels/useChannels', () => ({
  useChannelList: () => ({ data: channelsData }),
}));

vi.mock('../channels/useUnread', () => ({
  useUnreadSummary: () => ({ data: unreadData }),
}));

vi.mock('../dms/useDms', () => ({
  useDmList: () => ({ data: dmData }),
}));

let lruOrderData: string[] = [];
vi.mock('../realtime/channelLru', () => ({
  useChannelLruStore: (sel: (s: { order: string[] }) => unknown) => sel({ order: lruOrderData }),
}));

const announceMock = vi.fn();
vi.mock('../../lib/a11y-announce', () => ({
  announce: (msg: string, opts?: { resetDelayMs?: number }) => announceMock(msg, opts),
}));

import { QuickSwitcher } from './QuickSwitcher';

// ── fixtures ────────────────────────────────────────────────────────────────

let paramSlug: string | undefined = 'acme';

function chan(id: string, name: string) {
  return {
    id,
    workspaceId: 'ws1',
    categoryId: null,
    name,
    type: 'TEXT',
    topic: null,
    description: null,
    position: 'a0',
    slowmodeSeconds: 0,
    memberCanPin: true,
    fileUploadEnabled: true,
    maxFileSizeBytes: null,
    isPrivate: false,
    archivedAt: null,
    deletedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

let channelsData: { categories: never[]; uncategorized: ReturnType<typeof chan>[] } | undefined;

function member(userId: string, username: string, status = 'offline'): MemberWithPresence {
  return {
    userId,
    workspaceId: 'ws1',
    role: 'MEMBER',
    joinedAt: '2025-01-01T00:00:00.000Z',
    status: status as MemberWithPresence['status'],
    lastSeenAt: null,
    user: { id: userId, username, email: `${username}@qufox.dev` },
  };
}

let membersData: MemberWithPresence[] = [];
let unreadData: { channels: Array<{ channelId: string; unreadCount: number }> } | undefined;
let dmData: { items: Array<Record<string, unknown>> } | undefined;

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  paramSlug = 'acme';
  openModal = 'quick-switcher';
  setOpenModal.mockReset();
  navigate.mockReset();
  announceMock.mockReset();
  lruOrderData = [];
  channelsData = {
    categories: [],
    uncategorized: [
      chan('c-general', 'general'),
      chan('c-random', 'random'),
      chan('c-design', 'design'),
    ],
  };
  membersData = [member('u-alice', 'alice'), member('u-bob', 'bob'), member('me', 'self')];
  unreadData = { channels: [{ channelId: 'c-design', unreadCount: 3 }] };
  dmData = {
    items: [
      {
        channelId: 'dm1',
        otherUserId: 'u-carol',
        otherUsername: 'carol',
        lastMessageAt: '2025-01-01T10:00:00.000Z',
        lastMessagePreview: 'hi',
        unreadCount: 0,
        participants: [],
      },
    ],
  };
});

afterEach(() => cleanup());

describe('QuickSwitcher (FR-KS-01/02/03/11)', () => {
  it('renders nothing when the modal is closed', () => {
    openModal = null;
    const { container } = render(<QuickSwitcher />);
    expect(container.firstChild).toBeNull();
  });

  it('opens as a dialog with aria-modal and the correct aria-label (FR-KS-01)', () => {
    render(<QuickSwitcher />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // Radix labels the dialog via the Title — assert the title text is present.
    expect(document.body.textContent).toContain('채널/멤버/DM 이동');
  });

  it('autofocuses the search input on open (FR-KS-01)', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('role')).toBe('combobox');
  });

  it('shows recents + unread channels by default with no query (FR-KS-02)', () => {
    lruOrderData = ['ws1::c-random']; // 최근 방문 채널
    render(<QuickSwitcher />);
    const list = screen.getByRole('listbox');
    const text = list.textContent ?? '';
    // 최근(random) + 미읽(design) 이 기본 화면에 노출.
    expect(text).toContain('random');
    expect(text).toContain('design');
  });

  it('filters to channels only with the # prefix (FR-KS-01)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '#a' } });
    const items = screen.getAllByRole('option');
    items.forEach((li) => expect(li.getAttribute('data-kind')).toBe('channel'));
  });

  it('filters to members/DMs only with the @ prefix (FR-KS-01)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '@a' } });
    const items = screen.getAllByRole('option');
    expect(items.length).toBeGreaterThan(0);
    items.forEach((li) => expect(li.getAttribute('data-kind')).not.toBe('channel'));
  });

  it('excludes the current user from member results', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '@self' } });
    expect(screen.queryByText('self')).toBeNull();
  });

  it('moves focus with ArrowDown / ArrowUp (FR-KS-03)', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: '#' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('quick-switcher-item-1').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('quick-switcher-item-0').getAttribute('aria-selected')).toBe('true');
  });

  it('navigates to the channel route on Enter (FR-KS-03)', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: '#general' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/w/acme/general');
    expect(setOpenModal).toHaveBeenCalledWith(null);
  });

  it('navigates to the DM route on Enter for a member (FR-KS-03)', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: '@alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/dm/u-alice');
  });

  it('shows the empty state with data-state=empty + Ctrl+N hint when 0 results (FR-KS-11)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: 'zzzzz' } });
    const empty = screen.getByTestId('quick-switcher-empty');
    expect(empty.getAttribute('data-state')).toBe('empty');
    expect(empty.textContent).toContain('Ctrl+N');
    expect(screen.getByTestId('quick-switcher-browse')).toBeTruthy();
  });

  it('announces the result count on result changes (FR-KS-01)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '#a' } });
    expect(announceMock).toHaveBeenCalledWith(expect.stringMatching(/\d개 결과/), undefined);
  });

  // S82a fix-forward (a11y #4/#8): 기본 화면(쿼리 비어 있음)에서는 Dialog 제목
  // 낭독과 충돌하지 않도록 결과 수 공지를 건너뛴다.
  it('does NOT announce the result count on the blank default screen (a11y #4)', () => {
    lruOrderData = ['ws1::c-random'];
    render(<QuickSwitcher />);
    expect(announceMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/개 결과/),
      expect.anything(),
    );
  });

  // S82a fix-forward (a11y #8): 0건 + 쿼리가 있을 때 빈 상태 안내를 공지한다.
  it('announces the empty-state guidance when 0 results with a non-empty query (a11y #8)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: 'zzzzz' } });
    expect(announceMock).toHaveBeenCalledWith(
      expect.stringContaining('검색 결과가 없습니다'),
      undefined,
    );
  });

  it('falls back to DM-only when outside a workspace (no slug)', () => {
    paramSlug = undefined;
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: 'carol' } });
    const items = screen.getAllByRole('option');
    items.forEach((li) => expect(li.getAttribute('data-kind')).toBe('dm'));
    // 워크스페이스 밖에서는 채널 둘러보기 링크가 없다.
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: 'zzzz' } });
    expect(screen.queryByTestId('quick-switcher-browse')).toBeNull();
  });

  it('does not fire navigation while an IME composition is active', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: '#general' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('QuickSwitcher option metadata', () => {
  it('marks unread channels with an unread count meta', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '#design' } });
    const option = screen.getByRole('option');
    expect(within(option).getByText(/미읽음 3/)).toBeTruthy();
  });
});

// ── S82a fix-forward a11y / reviewer 보강 ─────────────────────────────────────

describe('QuickSwitcher a11y (S82a fix-forward)', () => {
  // a11y #1: 빈 상태(listbox DOM 제거)에서는 aria-expanded 가 false 여야 한다.
  it('sets aria-expanded=false and drops aria-controls/activedescendant when empty (a11y #1/#5)', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: 'zzzzz' } });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('sets aria-expanded=true with aria-controls when the listbox is shown (a11y #1)', () => {
    render(<QuickSwitcher />);
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: '#general' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('quick-switcher-listbox');
  });

  // a11y #6+#9: 각 option 에 종류를 구분하는 단일 aria-label 이 붙는다.
  it('labels each option with its kind + label + meta (a11y #6/#9)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '#design' } });
    const option = screen.getByRole('option');
    expect(option.getAttribute('aria-label')).toBe('채널: design, 미읽음 3');
  });

  it('labels member options with the 멤버 kind prefix (a11y #6/#9)', () => {
    render(<QuickSwitcher />);
    fireEvent.change(screen.getByTestId('quick-switcher-input'), { target: { value: '@alice' } });
    const option = screen.getByRole('option');
    expect(option.getAttribute('aria-label')).toContain('멤버: alice');
  });

  // a11y #10: 입력 접근명이 Dialog 제목과 구분된다.
  it('gives the search input a distinct aria-label from the dialog title (a11y #10)', () => {
    render(<QuickSwitcher />);
    expect(screen.getByTestId('quick-switcher-input').getAttribute('aria-label')).toBe(
      '채널·멤버·DM 검색',
    );
  });
});

describe('QuickSwitcher recency / dedupe (S82a reviewer MED-1)', () => {
  // reviewer MED-1: 상대가 멤버이기도 하면 행 id 는 mem: 이므로(DM 행은 dedupe),
  // 기본 화면 최근 목록에 그 멤버 행이 나타나야 한다(dm→mem fallback 으로 키 일치).
  it('boosts a recent DM partner who is also a member via the mem: row (dm→mem fallback)', () => {
    // alice 가 멤버이면서 최근 DM 상대.
    membersData = [member('u-alice', 'alice')];
    dmData = {
      items: [
        {
          channelId: 'dm-a',
          otherUserId: 'u-alice',
          otherUsername: 'alice',
          lastMessageAt: '2025-01-01T12:00:00.000Z',
          lastMessagePreview: 'yo',
          unreadCount: 0,
          participants: [],
        },
      ],
    };
    // 채널/미읽 없음 → 기본 화면은 최근 DM(=멤버 행)만.
    channelsData = { categories: [], uncategorized: [] };
    unreadData = { channels: [] };
    render(<QuickSwitcher />);
    const list = screen.getByRole('listbox');
    const option = within(list).getByRole('option');
    // 멤버 행으로 노출(@alice meta) — DM 중복 행 없음.
    expect(option.getAttribute('data-kind')).toBe('member');
    expect(option.getAttribute('aria-label')).toContain('멤버: alice');
    // 멤버 행이 1개뿐 — DM 중복 dedupe 확인.
    expect(within(list).getAllByRole('option')).toHaveLength(1);
  });

  // 외부 워크스페이스 LRU 키는 byId 필터로 걸러져 기본 화면에 새지 않는다.
  it('filters out LRU entries from other workspaces in the default recents (LRU key filter)', () => {
    lruOrderData = ['ws-other::c-foreign', 'ws1::c-random'];
    render(<QuickSwitcher />);
    const list = screen.getByRole('listbox');
    const text = list.textContent ?? '';
    // 현재 워크스페이스 채널(random)만 최근으로 노출, 외부 채널 id 는 미노출.
    expect(text).toContain('random');
    expect(text).not.toContain('c-foreign');
  });
});
