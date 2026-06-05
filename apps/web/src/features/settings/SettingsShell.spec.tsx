// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

let mobile = false;
vi.mock('../../lib/useBreakpoint', () => ({
  useIsMobile: () => mobile,
}));

import { SettingsShell, SETTINGS_TABS } from './SettingsShell';
import { useSettingsHotkey } from './useSettingsHotkey';

function HotkeyHost(): null {
  useSettingsHotkey();
  return null;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <HotkeyHost />
      <Routes>
        <Route path="/settings" element={<SettingsShell />}>
          <Route path="appearance" element={<div data-testid="page-appearance">외관</div>} />
          <Route path="profile" element={<div data-testid="page-profile">프로필</div>} />
          <Route path="notifications" element={<div data-testid="page-notifications">알림</div>} />
          <Route path="privacy" element={<div data-testid="page-privacy">프라이버시</div>} />
        </Route>
        <Route path="/" element={<div data-testid="home">home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  mobile = false;
});
afterEach(() => cleanup());

describe('SettingsShell (FR-PS-18)', () => {
  it('renders all 7 standard tabs in order', () => {
    renderAt('/settings/appearance');
    const labels = SETTINGS_TABS.map((t) => t.label);
    expect(labels).toEqual([
      '내 계정',
      '프로필',
      '외관',
      '알림',
      '접근성',
      '프라이버시 & 안전',
      '고급',
    ]);
    for (const t of SETTINGS_TABS) {
      expect(screen.getByTestId(`settings-tab-${t.id}`)).toBeTruthy();
    }
  });

  it('renders the active tab content via <Outlet/> (deep link)', () => {
    renderAt('/settings/appearance');
    expect(screen.getByTestId('page-appearance')).toBeTruthy();
    // F-H3 (a11y HIGH-03): role=link 에는 aria-selected 가 부적합 → aria-current="page" 단독.
    const tab = screen.getByTestId('settings-tab-appearance');
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(tab.getAttribute('aria-selected')).toBeNull();
  });

  it('deep links to a non-default tab keep working', () => {
    renderAt('/settings/notifications');
    expect(screen.getByTestId('page-notifications')).toBeTruthy();
    expect(screen.getByTestId('settings-tab-notifications').getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('disables account/accessibility/advanced tabs (S77 이후)', () => {
    renderAt('/settings/appearance');
    for (const id of ['account', 'accessibility', 'advanced']) {
      const el = screen.getByTestId(`settings-tab-${id}`);
      expect(el.getAttribute('aria-disabled')).toBe('true');
      // F-H2 (a11y HIGH-02): span 이 아니라 disabled <button> 이라 키보드/AT 가 인지한다.
      expect(el.tagName).toBe('BUTTON');
      expect((el as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('navigating tabs swaps Outlet content', () => {
    renderAt('/settings/appearance');
    fireEvent.click(screen.getByTestId('settings-tab-privacy'));
    expect(screen.getByTestId('page-privacy')).toBeTruthy();
  });

  it('Ctrl+, navigates to /settings/appearance', () => {
    renderAt('/');
    expect(screen.getByTestId('home')).toBeTruthy();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByTestId('page-appearance')).toBeTruthy();
  });

  it('Cmd+, (meta) also navigates to /settings/appearance', () => {
    renderAt('/');
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(screen.getByTestId('page-appearance')).toBeTruthy();
  });

  it('renders the mobile drilldown nav when no tab is active (list view)', () => {
    mobile = true;
    renderAt('/settings');
    expect(screen.getByTestId('settings-shell-mobile')).toBeTruthy();
    expect(screen.getByTestId('settings-mobile-nav')).toBeTruthy();
  });

  // F-B4 (a11y BLK-02): 모바일에서 자식 탭이 활성이면 셸 h1/nav 를 숨기고 Outlet 만
  // 렌더해 h1 중복(셸 "설정" + 자식 페이지 h1)을 막는다.
  it('mobile: when a child tab is active, hides shell nav and renders only the Outlet (F-B4)', () => {
    mobile = true;
    renderAt('/settings/appearance');
    expect(screen.getByTestId('settings-shell-mobile')).toBeTruthy();
    // 자식 콘텐츠만 렌더 — 셸 목록 nav 는 없다(h1 단일 소유는 자식).
    expect(screen.getByTestId('page-appearance')).toBeTruthy();
    expect(screen.queryByTestId('settings-mobile-nav')).toBeNull();
  });
});
