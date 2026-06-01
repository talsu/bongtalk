// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

/**
 * S31 (FR-S01/S02 — combobox ARIA + 치트시트 + suggest): SearchInput 의 접근성
 * 계약과 드롭다운 3분기를 jsdom 으로 검증한다. 데이터 hook(useSearch/
 * useRecentSearches)과 suggest API 를 모킹해 네트워크 없이 렌더링한다.
 */

// ── 모킹: 라우팅 / 데이터 hook / suggest API ──────────────────────────────────
const navigateSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}));

const recentState = {
  recents: [] as string[],
  removeOne: vi.fn(),
  clearAll: vi.fn(),
};
const searchState = {
  data: undefined as unknown,
  isLoading: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
};
vi.mock('./useSearch', () => ({
  useSearch: () => searchState,
  useRecentSearches: () => recentState,
  pushRecentSearch: vi.fn(),
}));

const suggestState = {
  data: undefined as unknown,
  isLoading: false,
};
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => suggestState,
}));

vi.mock('../channels/useChannels', () => ({
  useChannelList: () => ({
    data: {
      uncategorized: [{ id: 'c1', name: 'general' }],
      categories: [],
    },
  }),
}));

vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (_s: { openSearchPanel: () => void }) => unknown) =>
    sel({ openSearchPanel: vi.fn() }),
}));

vi.mock('./api', () => ({
  fetchSearchSuggest: vi.fn().mockResolvedValue({ channels: [], users: [] }),
}));

import { SearchInput } from './SearchInput';

function setup(): HTMLInputElement {
  render(<SearchInput workspaceId="ws1" workspaceSlug="acme" />);
  return screen.getByTestId('topbar-search') as HTMLInputElement;
}

beforeEach(() => {
  recentState.recents = [];
  recentState.removeOne = vi.fn();
  recentState.clearAll = vi.fn();
  searchState.data = undefined;
  searchState.isLoading = false;
  searchState.hasNextPage = false;
  suggestState.data = undefined;
  suggestState.isLoading = false;
  navigateSpy.mockReset();
});

afterEach(() => cleanup());

describe('SearchInput combobox ARIA (S31 FR-S02)', () => {
  it('input 은 role=combobox + aria-haspopup=listbox', () => {
    const input = setup();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-haspopup')).toBe('listbox');
    // 닫힌 상태에서 aria-expanded=false, listbox 없으므로 aria-controls 미설정.
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
  });

  // S31 (a11y B-1): listbox 가 없는 분기(치트시트/최근/로딩/빈결과)에서는
  // aria-expanded=false + aria-controls 미설정(dangling 방지). 빈 입력 +
  // 최근검색 0건 포커스는 치트시트 분기라 listbox 가 없다.
  it('치트시트 분기(listbox 없음)에서는 aria-expanded=false + aria-controls 없음', () => {
    const input = setup();
    fireEvent.focus(input);
    // 드롭다운 자체는 떠 있다.
    expect(screen.getByTestId('search-dropdown')).not.toBeNull();
    // 그러나 listbox 가 없으므로 expanded=false, controls 미설정.
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    // 치트시트 분기에는 role=listbox 요소가 없다.
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('SearchInput 치트시트 (S31 FR-S01)', () => {
  it('빈 입력 + 최근검색 0건 포커스면 수식어 치트시트 카드', () => {
    const input = setup();
    fireEvent.focus(input);
    const cheat = screen.getByTestId('search-cheatsheet');
    expect(cheat).not.toBeNull();
    expect(cheat.querySelector('.qf-search-overlay__filters')).not.toBeNull();
    expect(cheat.querySelector('.qf-search-overlay__chip-key')).not.toBeNull();
    expect(cheat.textContent).toContain('from:');
    expect(cheat.textContent).toContain('in:');
    expect(cheat.textContent).toContain('has:');
  });

  it('치트시트 칩 클릭 시 입력창에 수식어 프리필', () => {
    const input = setup();
    fireEvent.focus(input);
    const fromChip = screen.getByTestId('search-cheat-from');
    fireEvent.mouseDown(fromChip);
    expect(input.value).toBe('from:@alice ');
  });

  it('최근검색이 있으면 치트시트 대신 최근목록(개별/전체 삭제)', () => {
    recentState.recents = ['roadmap', 'deploy'];
    const input = setup();
    fireEvent.focus(input);
    expect(screen.queryByTestId('search-cheatsheet')).toBeNull();
    const recents = screen.getByTestId('search-recents');
    expect(recents.textContent).toContain('roadmap');
    // 개별 삭제.
    fireEvent.mouseDown(screen.getByTestId('search-recent-remove-roadmap'));
    expect(recentState.removeOne).toHaveBeenCalledWith('roadmap');
  });
});

describe('SearchInput suggest 분기 (S31 FR-S02)', () => {
  it('has: 입력 시 정적 옵션(image/file/link) listbox option 노출', () => {
    const input = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'has:' } });
    const suggest = screen.getByTestId('search-suggest');
    expect(suggest.getAttribute('role')).toBe('listbox');
    const options = within(suggest).getAllByRole('option');
    expect(options.length).toBe(3);
    expect(suggest.textContent).toContain('image');
    expect(suggest.textContent).toContain('file');
    expect(suggest.textContent).toContain('link');
  });

  // S31 (a11y B-1): suggest 분기의 aria-controls 는 실제 role=listbox 요소
  // (qf-search-listbox)를 가리켜야 한다. id 가 listbox <ul> 에 있고, input 의
  // aria-controls 가 그것과 일치해야 dangling 이 아니다.
  it('suggest listbox 가 aria-controls 대상 id(qf-search-listbox)를 보유', () => {
    const input = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'has:' } });
    const suggest = screen.getByTestId('search-suggest');
    expect(suggest.id).toBe('qf-search-listbox');
    // input.aria-controls 가 실제 listbox 를 가리킨다.
    expect(input.getAttribute('aria-controls')).toBe('qf-search-listbox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // 가리키는 요소가 role=listbox 다.
    const controlled = document.getElementById(input.getAttribute('aria-controls') ?? '');
    expect(controlled?.getAttribute('role')).toBe('listbox');
  });

  it('has:im 으로 좁히면 image 만', () => {
    const input = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'has:im' } });
    const options = within(screen.getByTestId('search-suggest')).getAllByRole('option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain('image');
  });

  it('ArrowDown 으로 highlight 이동 + aria-activedescendant 동기', () => {
    const input = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'has:' } });
    // 초기 활성 항목 = 0.
    expect(input.getAttribute('aria-activedescendant')).toBe('qf-search-opt-suggest-0');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('qf-search-opt-suggest-1');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe('qf-search-opt-suggest-0');
    // 선택된 option 은 aria-selected=true.
    const opt0 = document.getElementById('qf-search-opt-suggest-0');
    expect(opt0?.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter 로 활성 suggest 선택 시 토큰 완성(has:image )', () => {
    const input = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'has:' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('has:image ');
  });

  it('Escape 는 드롭다운을 닫는다(input 포커스 유지)', () => {
    const input = setup();
    // 실제 DOM 포커스를 줘서 N-3(Esc 가 blur 하지 않음) 회귀를 확인한다.
    input.focus();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'has:' } });
    // suggest listbox 가 떠 있어 expanded=true.
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    // 드롭다운 닫힘.
    expect(screen.queryByTestId('search-dropdown')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    // S31 (a11y N-3): Esc 는 blur 하지 않는다 — 포커스 유지.
    expect(document.activeElement).toBe(input);
  });
});

describe('SearchInput 결과 분기 (S31 FR-S02 combobox)', () => {
  function seedResults(hasNextPage = false): void {
    searchState.data = {
      pages: [
        {
          results: [
            {
              messageId: 'm1',
              channelId: 'c1',
              channelName: 'general',
              senderId: 'u1',
              senderName: 'alice',
              createdAt: '2025-01-01T00:00:00.000Z',
              snippet: 'hello <mark>x</mark>',
              rank: 0.5,
            },
          ],
          nextCursor: hasNextPage ? 'cur' : null,
        },
      ],
    };
    searchState.hasNextPage = hasNextPage;
  }

  function openResults(): HTMLInputElement {
    vi.useFakeTimers();
    const input = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'hello' } });
    // debounced 300ms — 결과 분기는 debounced 값이 있어야 한다.
    act(() => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();
    return input;
  }

  it('결과가 있으면 role=listbox + 각 항목 role=option/aria-selected', () => {
    seedResults();
    const input = openResults();
    const list = screen.getByTestId('search-results');
    expect(list.getAttribute('role')).toBe('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.length).toBe(1);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[0].id).toBe('qf-search-opt-result-0');
    // 사용하지 않은 input 참조를 무해하게 소비.
    expect(input.getAttribute('role')).toBe('combobox');
  });

  // S31 (a11y B-1): 결과 분기의 listbox 가 aria-controls 대상 id 를 보유하고
  // input.aria-controls 가 그것을 가리킨다.
  it('결과 listbox 가 aria-controls 대상 id(qf-search-listbox)를 보유', () => {
    seedResults();
    const input = openResults();
    const list = screen.getByTestId('search-results');
    expect(list.id).toBe('qf-search-listbox');
    expect(input.getAttribute('aria-controls')).toBe('qf-search-listbox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const controlled = document.getElementById('qf-search-listbox');
    expect(controlled?.getAttribute('role')).toBe('listbox');
  });

  // S31 (a11y B-2): "더 보기" 버튼은 role=option 이 아니므로 listbox(<ul>)
  // 안에 있으면 안 된다. listbox 바깥(형제)에 있어야 한다.
  it('"더 보기" 버튼은 listbox(<ul role=listbox>) 바깥에 있다', () => {
    seedResults(true);
    openResults();
    const list = screen.getByTestId('search-results');
    const loadMore = screen.getByTestId('search-load-more');
    expect(loadMore).not.toBeNull();
    // load-more 가 listbox <ul> 의 자손이 아니어야 한다.
    expect(list.contains(loadMore)).toBe(false);
    // listbox 자식은 모두 role=option 이어야 한다(load-more 가 섞이지 않음).
    const nonOptionChildren = Array.from(list.children).filter(
      (el) => el.getAttribute('role') !== 'option',
    );
    expect(nonOptionChildren.length).toBe(0);
  });
});
