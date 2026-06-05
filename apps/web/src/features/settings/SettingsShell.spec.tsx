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
          <Route path="account" element={<div data-testid="page-account">내 계정</div>} />
          <Route path="appearance" element={<div data-testid="page-appearance">외관</div>} />
          <Route path="profile" element={<div data-testid="page-profile">프로필</div>} />
          <Route path="notifications" element={<div data-testid="page-notifications">알림</div>} />
          <Route
            path="accessibility"
            element={<div data-testid="page-accessibility">접근성</div>}
          />
          <Route path="privacy" element={<div data-testid="page-privacy">프라이버시</div>} />
          <Route path="advanced" element={<div data-testid="page-advanced">고급</div>} />
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

  // S77c (D14 / FR-PS-16·19): 고급 탭이 활성화되어 더 이상 비활성 탭이 없다 — 7탭 전부 Link(<a>)다.
  it('enables every standard tab (no disabled tab after S77c)', () => {
    renderAt('/settings/appearance');
    for (const t of SETTINGS_TABS) {
      const el = screen.getByTestId(`settings-tab-${t.id}`);
      expect(el.tagName).toBe('A'); // enabled → Link(<a>), not a disabled button.
    }
  });

  // S77b (D14 / FR-PS-15·20): 내 계정 탭이 활성화(enabled)되어 딥링크/Outlet 이 동작한다.
  it('enables the account tab and deep-links to its Outlet content (S77b)', () => {
    renderAt('/settings/account');
    const tab = screen.getByTestId('settings-tab-account');
    expect(tab.tagName).toBe('A'); // enabled → Link(<a>), not a disabled button.
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('page-account')).toBeTruthy();
  });

  // S77c: 모바일에서도 모든 탭이 활성(enabled)이라 disabled 행이 없다(전 탭 클릭 가능).
  it('mobile: all tabs are enabled (no disabled row) + no ghost qf-m-list class', () => {
    mobile = true;
    renderAt('/settings');
    for (const t of SETTINGS_TABS) {
      const el = screen.getByTestId(`settings-tab-${t.id}`) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      expect(el.getAttribute('aria-disabled')).toBeNull();
    }
    // F4 (ui M-1): 모바일 nav 는 유령 클래스 qf-m-list 를 더 이상 쓰지 않는다.
    const nav = screen.getByTestId('settings-mobile-nav');
    expect(nav.classList.contains('qf-m-list')).toBe(false);
  });

  // S77a: 접근성 탭이 활성화(enabled)되어 딥링크/Outlet 이 동작한다.
  it('enables the accessibility tab and deep-links to its Outlet content (S77a)', () => {
    renderAt('/settings/accessibility');
    const tab = screen.getByTestId('settings-tab-accessibility');
    expect(tab.tagName).toBe('A'); // enabled → Link(<a>), not a disabled button.
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('page-accessibility')).toBeTruthy();
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
