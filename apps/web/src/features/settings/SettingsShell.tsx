import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useIsMobile } from '../../lib/useBreakpoint';

/**
 * S76 (D14 / FR-PS-18): 설정 정보구조(IA) 셸 — Layout Route(Fork A1).
 *
 * 7탭 표준(내 계정 / 프로필 / 외관 / 알림 / 접근성 / 프라이버시 & 안전 / 고급)을
 * 좌측 사이드바 + 우측 <Outlet/> 으로 구성한다. 각 탭 라우트는 SettingsShell 의
 * 자식으로 중첩되며 콘텐츠는 Outlet 에 렌더된다(딥링크 유지). 모바일은 사이드바를
 * 드릴다운 목록으로 보여주고(탭 선택 시 라우트 진입), 콘텐츠 라우트에서는 목록 대신
 * Outlet 만 렌더한다.
 *
 * 활성 탭(S76): 외관(신규) · 프로필(S73) · 알림(S46) · 프라이버시 & 안전(S75).
 * 비활성(S77 이후): 내 계정 · 접근성 · 고급 — disabled 로 표시.
 *
 * Ctrl+,(Cmd+,) 전역 단축키는 App 레벨에서 라우팅을 담당하므로 여기서는 셸 안의
 * 탐색 UX 만 책임진다(전역 핸들러는 useSettingsHotkey).
 */

export type SettingsTabId =
  | 'account'
  | 'profile'
  | 'appearance'
  | 'notifications'
  | 'accessibility'
  | 'privacy'
  | 'advanced';

type TabDef = {
  id: SettingsTabId;
  label: string;
  path: string;
  enabled: boolean;
};

// FR-PS-18: 7탭 표준 순서. enabled=false 는 S77 이후 활성(현재 disabled).
export const SETTINGS_TABS: readonly TabDef[] = [
  { id: 'account', label: '내 계정', path: '/settings/account', enabled: false },
  { id: 'profile', label: '프로필', path: '/settings/profile', enabled: true },
  { id: 'appearance', label: '외관', path: '/settings/appearance', enabled: true },
  { id: 'notifications', label: '알림', path: '/settings/notifications', enabled: true },
  { id: 'accessibility', label: '접근성', path: '/settings/accessibility', enabled: false },
  { id: 'privacy', label: '프라이버시 & 안전', path: '/settings/privacy', enabled: true },
  { id: 'advanced', label: '고급', path: '/settings/advanced', enabled: false },
];

function activeTabId(pathname: string): SettingsTabId | null {
  const hit = SETTINGS_TABS.find((t) => pathname.startsWith(t.path));
  return hit?.id ?? null;
}

export function SettingsShell(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const active = activeTabId(location.pathname);

  // 모바일 '설정' 루트(/settings 자체는 redirect 라 닿지 않지만, 드릴다운 목록 화면을
  // 별도 경로 없이 표현하려고 콘텐츠가 비활성/미선택일 때 목록을 보여준다). 데스크톱은
  // 항상 사이드바 + Outlet 동시 렌더.
  if (isMobile) {
    return (
      <main className="qf-m-screen" data-testid="settings-shell-mobile">
        <header className="qf-m-topbar">
          <Link to="/" className="qf-m-topbar__back" aria-label="홈으로">
            ←
          </Link>
          <h1 className="qf-m-topbar__title">설정</h1>
        </header>
        <nav className="qf-m-list" aria-label="설정" data-testid="settings-mobile-nav">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="qf-m-row"
              data-testid={`settings-tab-${t.id}`}
              aria-current={active === t.id ? 'page' : undefined}
              aria-disabled={!t.enabled || undefined}
              disabled={!t.enabled}
              onClick={() => t.enabled && navigate(t.path)}
            >
              <span className="qf-m-row__primary">{t.label}</span>
              {!t.enabled && <span className="qf-m-row__secondary">준비 중</span>}
            </button>
          ))}
        </nav>
        {/* 모바일에서 콘텐츠는 선택된 탭 라우트가 전체 화면으로 대체 렌더한다(Outlet). */}
        <div data-testid="settings-mobile-outlet">
          <Outlet />
        </div>
      </main>
    );
  }

  return (
    <div className="qf-settings" data-testid="settings-shell">
      <nav className="qf-settings__nav" aria-label="설정" data-testid="settings-nav">
        <div className="qf-settings__nav-head">설정</div>
        {SETTINGS_TABS.map((t) =>
          t.enabled ? (
            <Link
              key={t.id}
              to={t.path}
              className="qf-settings__nav-item"
              data-testid={`settings-tab-${t.id}`}
              aria-selected={active === t.id}
              aria-current={active === t.id ? 'page' : undefined}
            >
              {t.label}
            </Link>
          ) : (
            <span
              key={t.id}
              className="qf-settings__nav-item"
              data-testid={`settings-tab-${t.id}`}
              aria-disabled="true"
              title="준비 중입니다"
              style={{ opacity: 0.5, cursor: 'not-allowed' }}
            >
              {t.label}
            </span>
          ),
        )}
      </nav>
      <section className="qf-settings__main" data-testid="settings-content">
        <Outlet />
      </section>
    </div>
  );
}
