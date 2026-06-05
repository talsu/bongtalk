import { useEffect, useRef } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useIsMobile } from '../../lib/useBreakpoint';

/**
 * S76 (D14 / FR-PS-18): 설정 정보구조(IA) 셸 — Layout Route(Fork A1).
 *
 * 7탭 표준(내 계정 / 프로필 / 외관 / 알림 / 접근성 / 프라이버시 & 안전 / 고급)을
 * 좌측 사이드바 + 우측 <Outlet/> 으로 구성한다. 각 탭 라우트는 SettingsShell 의
 * 자식으로 중첩되며 콘텐츠는 Outlet 에 렌더된다(딥링크 유지). 모바일은 사이드바를
 * 드릴다운 목록으로 보여주고(탭 선택 시 라우트 진입), 콘텐츠 라우트에서는 목록 대신
 * Outlet 만 렌더한다(F-B4 — 자식이 자체 h1 소유).
 *
 * 활성 탭: 외관(S76) · 프로필(S73) · 알림(S46) · 접근성(S77a) · 프라이버시 & 안전(S75/S77a) ·
 * 내 계정(S77b) · 고급(S77c — 계정 비활성화/삭제).
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

// FR-PS-18: 7탭 표준 순서. enabled=false 는 후속 슬라이스에서 활성.
// S77b (D14 / FR-PS-15·20): 내 계정 탭 활성(자격증명 변경·2FA·세션).
// S77c (D14 / FR-PS-16·19): 고급 탭 활성(계정 비활성화/삭제 위험구역).
export const SETTINGS_TABS: readonly TabDef[] = [
  { id: 'account', label: '내 계정', path: '/settings/account', enabled: true },
  { id: 'profile', label: '프로필', path: '/settings/profile', enabled: true },
  { id: 'appearance', label: '외관', path: '/settings/appearance', enabled: true },
  { id: 'notifications', label: '알림', path: '/settings/notifications', enabled: true },
  { id: 'accessibility', label: '접근성', path: '/settings/accessibility', enabled: true },
  { id: 'privacy', label: '프라이버시 & 안전', path: '/settings/privacy', enabled: true },
  { id: 'advanced', label: '고급', path: '/settings/advanced', enabled: true },
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

  // F-H5 (a11y HIGH-05): 셸 마운트 시 첫 활성 nav 항목에 포커스를 옮긴다(키보드/SR
  // 사용자가 설정 진입 직후 탐색 컨텍스트를 바로 얻도록). 데스크톱 사이드바와 모바일
  // 목록 모두 첫 활성 항목 ref 에 focus().
  const firstNavRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);
  // 마운트 시 1회만 포커스를 옮긴다(라우트 변경/탭 전환마다 포커스를 빼앗지 않도록 deps 는
  // 의도적으로 비운다 — exhaustive-deps 룰은 이 워크스페이스 ESLint 설정에 없어 disable
  // 디렉티브를 두지 않는다).
  useEffect(() => {
    firstNavRef.current?.focus();
  }, []);

  // F-B4 (a11y BLK-02): 모바일에서 자식 탭(콘텐츠 라우트)이 활성이면 셸의 h1/nav 를
  // 숨기고 Outlet 만 렌더한다 — 자식 페이지가 자체 h1 을 소유하므로 h1 중복을 막는다.
  // /settings 자체는 redirect 라 닿지 않지만, active 가 null 인 예외 상황에서는 목록을 보여준다.
  if (isMobile) {
    if (active !== null) {
      return (
        <div className="qf-m-screen" data-testid="settings-shell-mobile">
          {/* 모바일 콘텐츠 라우트: 자식이 전체 화면 + 자체 h1 을 소유(셸 h1/nav 미렌더). */}
          <div data-testid="settings-mobile-outlet">
            <Outlet />
          </div>
        </div>
      );
    }
    return (
      <div className="qf-m-screen" data-testid="settings-shell-mobile">
        <header className="qf-m-topbar">
          <Link to="/" className="qf-m-topbar__back" aria-label="홈으로">
            ←
          </Link>
          <h1 className="qf-m-topbar__title">설정</h1>
        </header>
        {/* F4 (ui M-1): qf-m-list 는 mobile.css 에 등록되지 않은 유령 클래스라 스타일이 전혀
            적용되지 않았다. nav 컨테이너는 클래스 없이 두고(자식 qf-m-row 가 자체 chrome/divider
            를 소유), 각 행은 DS 의 qf-m-row 를 그대로 쓴다. */}
        <nav aria-label="설정" data-testid="settings-mobile-nav">
          {SETTINGS_TABS.map((t, i) => (
            <button
              key={t.id}
              ref={i === 0 ? (firstNavRef as React.Ref<HTMLButtonElement>) : undefined}
              type="button"
              className="qf-m-row disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`settings-tab-${t.id}`}
              aria-current={active === t.id ? 'page' : undefined}
              // F9 (a11y MINOR-03): aria-disabled 는 문자열로 명시한다("true" 또는 미부여).
              aria-disabled={!t.enabled ? 'true' : undefined}
              disabled={!t.enabled}
              onClick={() => t.enabled && navigate(t.path)}
            >
              <span className="qf-m-row__primary">{t.label}</span>
              {!t.enabled && <span className="qf-m-row__secondary">준비 중</span>}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  // 첫 활성(enabled) 탭의 id — 사이드바에서 그 항목에 포커스 ref 를 단다(F-H5).
  const firstEnabledId = SETTINGS_TABS.find((t) => t.enabled)?.id;

  return (
    <div className="qf-settings" data-testid="settings-shell">
      <nav className="qf-settings__nav" aria-label="설정" data-testid="settings-nav">
        <div className="qf-settings__nav-head">설정</div>
        {SETTINGS_TABS.map((t) =>
          t.enabled ? (
            <Link
              key={t.id}
              ref={
                t.id === firstEnabledId ? (firstNavRef as React.Ref<HTMLAnchorElement>) : undefined
              }
              to={t.path}
              className="qf-settings__nav-item"
              data-testid={`settings-tab-${t.id}`}
              // F-H3 (a11y HIGH-03): role=link 에는 aria-selected 가 부적합하다 —
              // aria-current="page" 단독으로 현재 탭을 표시한다.
              aria-current={active === t.id ? 'page' : undefined}
            >
              {t.label}
            </Link>
          ) : (
            // F-H2 (a11y HIGH-02): disabled 탭은 span 대신 disabled 버튼으로 둬 키보드/AT
            // 가 인지하게 한다(span aria-disabled 는 포커스/통지 불가). raw inline style 대신
            // Tailwind 유틸로 시각 비활성을 표현한다.
            // F9 (a11y MINOR-02): native `disabled` 가 이미 포커스 차단 + AT 비활성 통지를
            // 모두 담당하므로 aria-disabled 중복을 제거한다(disabled 단독으로 일관).
            <button
              key={t.id}
              type="button"
              disabled
              title="준비 중입니다"
              className="qf-settings__nav-item cursor-not-allowed opacity-50"
              data-testid={`settings-tab-${t.id}`}
            >
              {t.label}
            </button>
          ),
        )}
      </nav>
      <section className="qf-settings__main" data-testid="settings-content">
        <Outlet />
      </section>
    </div>
  );
}
