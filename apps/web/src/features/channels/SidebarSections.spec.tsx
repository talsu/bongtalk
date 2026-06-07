// @vitest-environment jsdom
/**
 * S85 (FR-CH-16) — SidebarSections 단위 회귀고정.
 *
 * 모든 네트워크는 lib/api 의 apiRequest 단일 경계를 vi.fn 으로 모킹한다. dnd-kit 의
 * 실제 드래그는 jsdom 에서 재현이 어려우므로 재정렬은 API 계약 테스트(int) + 순수
 * anchor 계산 단위로 검증하고, 여기서는 렌더/sortMode 표시/할당 채널 제외/optimistic
 * (invalidate 재조회) 같은 결정적 UI 동작을 고정한다.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const apiRequest = vi.fn();
vi.mock('../../lib/api', () => ({
  apiRequest: (path: string, opts?: unknown) => apiRequest(path, opts),
}));

import { ChannelList } from './ChannelList';
import { computeSectionChannelOrder } from './sidebarSectionOrder';

const WS = '11111111-1111-4111-8111-111111111111';
const CH_A = '44444444-4444-4444-8444-444444444444'; // apple (uncategorized)
const CH_B = '55555555-5555-4555-8555-555555555555'; // banana (uncategorized)
const CH_C = '66666666-6666-4666-8666-666666666666'; // cherry (uncategorized)
const SEC = '77777777-7777-4777-8777-777777777777';

function channel(id: string, name: string) {
  return {
    id,
    workspaceId: WS,
    categoryId: null,
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

type Section = {
  id: string;
  name: string;
  emoji: string | null;
  sortMode: 'MANUAL' | 'ALPHABETICAL';
  position: string;
  channelIds: string[];
};

function section(over: Partial<Section> = {}): Section {
  return {
    id: SEC,
    name: '작업',
    emoji: null,
    sortMode: 'MANUAL',
    position: '1000',
    channelIds: [],
    ...over,
  };
}

type ApiState = { sections: Section[] };

function installApi(state: ApiState): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === `/workspaces/${WS}/channels`) {
      return {
        categories: [],
        // cherry, banana, apple 순으로 제공(MANUAL position 순서 검증용)
        uncategorized: [channel(CH_C, 'cherry'), channel(CH_B, 'banana'), channel(CH_A, 'apple')],
      };
    }
    if (path === `/workspaces/${WS}/unread-summary`) return { channels: [] };
    if (path === '/me/mutes') return { items: [] };
    if (path === '/me/favorites') return { items: [] };
    if (path === `/workspaces/${WS}/sidebar-sections`) {
      return {
        sections: state.sections.map((s) => ({
          ...s,
          workspaceId: WS,
          createdAt: '2025-01-01T00:00:00.000Z',
        })),
      };
    }
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

function renderList(state: ApiState) {
  installApi(state);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ChannelList workspaceId={WS} workspaceSlug="ws" canManage activeChannelName={null} />,
    { wrapper: wrapper(qc) },
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

describe('computeSectionChannelOrder — 드래그 anchor 계산', () => {
  it('뒤로 이동 시 다음 항목 = beforeId', () => {
    // [a,b,c] 에서 a 를 c 뒤로 → [b,c,a]. a 의 anchor 는 앞 항목 c(afterId).
    const r = computeSectionChannelOrder(['a', 'b', 'c'], 'a', 'c');
    expect(r).toEqual({ afterId: 'c' });
  });

  it('앞으로 이동 시 뒤 항목 = beforeId', () => {
    // [a,b,c] 에서 c 를 a 앞으로 → [c,a,b]. c 의 anchor 는 뒤 항목 a(beforeId).
    const r = computeSectionChannelOrder(['a', 'b', 'c'], 'c', 'a');
    expect(r).toEqual({ beforeId: 'a' });
  });

  it('대상=anchor(노op)면 null', () => {
    expect(computeSectionChannelOrder(['a', 'b'], 'a', 'a')).toBeNull();
  });
});

describe('SidebarSections — 렌더 + sortMode', () => {
  it('섹션 0개면 영역을 렌더하지 않는다', async () => {
    renderList({ sections: [] });
    await screen.findByTestId('channel-sidebar');
    expect(screen.queryByTestId('sidebar-sections')).toBeNull();
  });

  it('MANUAL 섹션은 서버 channelIds 순서를 그대로 표시', async () => {
    // channelIds = [cherry, apple] → 그 순서대로
    renderList({ sections: [section({ channelIds: [CH_C, CH_A] })] });
    const block = await screen.findByTestId(`sidebar-section-${SEC}`);
    const rows = block.querySelectorAll('[data-testid^="sidebar-section-channel-"]');
    const names = Array.from(rows).map((r) => r.getAttribute('data-testid'));
    expect(names).toEqual(['sidebar-section-channel-cherry', 'sidebar-section-channel-apple']);
  });

  it('ALPHABETICAL 섹션은 채널명 가나다 정렬로 표시(저장 순서 무관)', async () => {
    // channelIds = [cherry, apple, banana] 인데 알파벳 → apple, banana, cherry
    renderList({
      sections: [section({ sortMode: 'ALPHABETICAL', channelIds: [CH_C, CH_A, CH_B] })],
    });
    const block = await screen.findByTestId(`sidebar-section-${SEC}`);
    expect(block.getAttribute('data-sort-mode')).toBe('ALPHABETICAL');
    const rows = block.querySelectorAll('[data-testid^="sidebar-section-channel-"]');
    const names = Array.from(rows).map((r) => r.getAttribute('data-testid'));
    expect(names).toEqual([
      'sidebar-section-channel-apple',
      'sidebar-section-channel-banana',
      'sidebar-section-channel-cherry',
    ]);
  });

  it('섹션에 할당된 채널은 카테고리 기본 위치에서 제외된다', async () => {
    // apple 을 섹션에 할당 → 기본 위치(채널 사이드바)에는 cherry, banana 만 남는다.
    renderList({ sections: [section({ channelIds: [CH_A] })] });
    await screen.findByTestId(`sidebar-section-${SEC}`);
    // 섹션 안의 apple 은 보이지만, 기본 위치 행(channel-apple)은 없다.
    expect(screen.queryByTestId('channel-apple')).toBeNull();
    expect(await screen.findByTestId('channel-cherry')).toBeTruthy();
    expect(await screen.findByTestId('channel-banana')).toBeTruthy();
  });

  it('섹션 헤더에 옵션 메뉴 트리거 + 이모지가 노출된다', async () => {
    renderList({ sections: [section({ emoji: '📌', channelIds: [] })] });
    const block = await screen.findByTestId(`sidebar-section-${SEC}`);
    // 옵션 메뉴 트리거(이름변경/삭제 진입점) 존재.
    expect(screen.getByTestId(`sidebar-section-menu-${SEC}`)).toBeTruthy();
    // 헤더에 이모지 표시.
    expect(block.textContent).toContain('📌');
    expect(block.textContent).toContain('작업');
  });
});
