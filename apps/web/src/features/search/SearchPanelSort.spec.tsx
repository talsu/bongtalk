// @vitest-environment jsdom
/**
 * 072-N4 — 검색 정렬 탭(N4-2) + 점프-후-패널-유지 계약(N4-1) 회귀고정.
 *
 *  - 정렬 탭: role=tablist/tab, roving tabindex(선택만 0), 클릭 → onSortChange,
 *    화살표(ArrowRight)로 이동+선택, aria-controls → tabpanel.
 *  - N4-1 계약: SearchResultPanelContainer.onJump 가 closeSearchPanel() 을
 *    호출하지 않는다(점프 후 패널 유지) — 소스 정적 검증.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SearchResultPanel } from './SearchResultPanel';

afterEach(() => cleanup());

function renderPanel(over: Partial<Parameters<typeof SearchResultPanel>[0]> = {}) {
  const onSortChange = vi.fn();
  render(
    <SearchResultPanel
      query="needle"
      results={[]}
      sort="relevance"
      onSortChange={onSortChange}
      channelNameById={new Map()}
      isLoading={false}
      hasNextPage={false}
      isFetchingNextPage={false}
      indexUpdateAvailable={false}
      recents={[]}
      onJump={() => undefined}
      onLoadMore={() => undefined}
      onReSearch={() => undefined}
      onPickRecent={() => undefined}
      onRemoveRecent={() => undefined}
      onClearRecent={() => undefined}
      onClose={() => undefined}
      {...over}
    />,
  );
  return { onSortChange };
}

describe('072-N4-2 검색 정렬 탭', () => {
  it('roving tabindex — 선택된 탭만 tabIndex=0, aria-controls=tabpanel', () => {
    renderPanel({ sort: 'relevance' });
    const rel = screen.getByTestId('search-sort-relevance');
    const rec = screen.getByTestId('search-sort-recent');
    expect(rel.getAttribute('tabindex')).toBe('0');
    expect(rec.getAttribute('tabindex')).toBe('-1');
    expect(rel.getAttribute('aria-controls')).toBe('search-panel-results');
    expect(rel.getAttribute('aria-selected')).toBe('true');
    // tabpanel 연결.
    const panel = screen.getByTestId('search-panel-results');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('search-sort-tab-relevance');
  });

  it('클릭 → onSortChange(recent)', () => {
    const { onSortChange } = renderPanel({ sort: 'relevance' });
    fireEvent.click(screen.getByTestId('search-sort-recent'));
    expect(onSortChange).toHaveBeenCalledWith('recent');
  });

  it('ArrowRight → 다음 탭으로 이동+선택(onSortChange)', () => {
    const { onSortChange } = renderPanel({ sort: 'relevance' });
    fireEvent.keyDown(screen.getByTestId('search-sort-relevance'), { key: 'ArrowRight' });
    expect(onSortChange).toHaveBeenCalledWith('recent');
  });

  it('최근검색 모드(빈 쿼리)에선 정렬 탭/ tabpanel 역할 없음', () => {
    renderPanel({ query: '', sort: 'relevance' });
    expect(screen.queryByTestId('search-sort-relevance')).toBeNull();
    expect(screen.getByTestId('search-panel-results').getAttribute('role')).toBeNull();
  });
});

describe('072-N4-1 점프 후 패널 유지 계약', () => {
  it('SearchResultPanelContainer.onJump 이 closeSearchPanel() 을 호출하지 않는다', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const src = readFileSync(
      `${root}/apps/web/src/features/search/SearchResultPanelContainer.tsx`,
      'utf8',
    );
    // onJump 함수 본문 추출(navigate 직후 closeSearchPanel 이 없어야 함).
    const start = src.indexOf('const onJump');
    const onJumpBody = src.slice(start, src.indexOf('return (', start));
    expect(onJumpBody).toContain('navigate(');
    expect(onJumpBody).not.toContain('closeSearchPanel()');
  });
});
