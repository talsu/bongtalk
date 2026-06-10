import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../features/auth/AuthProvider';
import { usePresenceStatus } from '../../features/presence/usePresenceStatus';
import type { PresenceStatus } from '../../features/presence/presenceStatus';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { MobileTabBar } from './MobileTabBar';

/**
 * 071-M2 E3 (FR-IA-MOB-06 / FR-P04·P17 / PRD §02 5탭): '나' 탭.
 *
 * DS 'You tab' 정본(qf-m-you-header / qf-m-you-status) + qf-m-row 드릴다운:
 *   - you-header: 아바타 + 이름 + @핸들 + 상태 라벨(상태 닷 변형 --idle/--dnd).
 *   - 상태 변경 행 → 바텀시트(온라인/방해 금지/오프라인 표시 — FR-P04/P17,
 *     서버 PATCH /me/presence = usePresenceStatus, idle 은 자동 전용이라 제외).
 *   - 내 프로필(/me/profile) · 설정(/settings) 드릴다운.
 *   - 로그아웃: confirm 시트(파괴적 — 우발 방지) 후 useAuth.logout → /login.
 */
const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: '온라인',
  idle: '자리 비움',
  dnd: '방해 금지',
  offline: '오프라인 표시',
};

export function MobileYouTab(): JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { status, setStatus, pending } = usePresenceStatus('online');
  const [statusSheet, setStatusSheet] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);

  const username = user?.username ?? '';

  const pick = (next: PresenceStatus): void => {
    void setStatus(next);
    setStatusSheet(false);
  };

  return (
    <div data-testid="mobile-you-tab" className="qf-m-screen qf-m-screen--app">
      <header className="qf-m-topbar qf-m-safe-top">
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">나</div>
        </div>
      </header>
      <main className="qf-m-body flex min-h-0 flex-col overflow-y-auto">
        <div
          className={cn(
            'qf-m-you-header',
            status === 'idle' && 'qf-m-you-header--idle',
            status === 'dnd' && 'qf-m-you-header--dnd',
            status === 'offline' && 'qf-m-you-header--offline',
          )}
        >
          <Avatar name={username || 'me'} size="lg" />
          <div className="qf-m-you-header__meta">
            <div className="qf-m-you-header__name">{username}</div>
            <div className="qf-m-you-header__handle">@{username}</div>
            <div className="qf-m-you-header__state" data-testid="mobile-you-state">
              {STATUS_LABEL[status]}
            </div>
          </div>
        </div>

        <button
          type="button"
          data-testid="mobile-you-status"
          className="qf-m-you-status"
          aria-haspopup="dialog"
          aria-expanded={statusSheet}
          disabled={pending}
          onClick={() => setStatusSheet(true)}
        >
          <Icon name="emoji" size="sm" />
          <span className="flex-1 text-left">상태 변경</span>
          <Icon name="chevron-right" size="sm" className="text-text-muted" />
        </button>

        <nav aria-label="내 메뉴">
          <button
            type="button"
            data-testid="mobile-you-profile"
            className="qf-m-row w-full text-left"
            onClick={() => navigate('/me/profile')}
          >
            <Icon name="user" size="sm" className="text-text-muted" />
            <span className="qf-m-row__primary flex-1">내 프로필</span>
            <Icon name="chevron-right" size="sm" className="text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-you-settings"
            className="qf-m-row w-full text-left"
            onClick={() => navigate('/settings')}
          >
            <Icon name="settings" size="sm" className="text-text-muted" />
            <span className="qf-m-row__primary flex-1">설정</span>
            <Icon name="chevron-right" size="sm" className="text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-you-logout"
            className="qf-m-row w-full text-left"
            onClick={() => setLogoutConfirm(true)}
          >
            <Icon name="logout" size="sm" className="text-[color:var(--danger-400)]" />
            <span className="qf-m-row__primary flex-1 text-[color:var(--danger-400)]">
              로그아웃
            </span>
          </button>
        </nav>
      </main>
      <MobileTabBar />

      {/* 상태 변경 바텀시트(FR-P04/P17) — idle 은 자동 전용이라 선택지 제외. */}
      {statusSheet ? (
        <div
          data-testid="mobile-status-sheet"
          className="fixed inset-0 z-[var(--z-modal,60)]"
          role="dialog"
          aria-modal="true"
          aria-label="상태 변경"
        >
          <div
            className="qf-m-sheet-backdrop absolute inset-0"
            onClick={() => setStatusSheet(false)}
          />
          <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]">
            <div className="qf-m-sheet__grab" aria-hidden />
            {(['online', 'dnd', 'offline'] as PresenceStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`mobile-status-${s}`}
                className="qf-m-sheet__item"
                aria-pressed={status === s}
                onClick={() => pick(s)}
              >
                <span className="qf-m-sheet__icon">
                  <span
                    className={`qf-avatar__status qf-avatar__status--${s === 'offline' ? 'offline' : s}`}
                    style={{ position: 'static' }}
                    aria-hidden
                  />
                </span>
                <span>{STATUS_LABEL[s]}</span>
                {status === s ? <Icon name="check" size="sm" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 로그아웃 confirm 시트 — 파괴적 액션 우발 방지. */}
      {logoutConfirm ? (
        <div
          data-testid="mobile-logout-confirm"
          className="fixed inset-0 z-[var(--z-modal,60)]"
          role="alertdialog"
          aria-modal="true"
          aria-label="로그아웃 확인"
        >
          <div
            className="qf-m-sheet-backdrop absolute inset-0"
            onClick={() => setLogoutConfirm(false)}
          />
          <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]">
            <div className="qf-m-sheet__grab" aria-hidden />
            <button
              type="button"
              data-testid="mobile-logout-submit"
              className="qf-m-sheet__item qf-m-sheet__item--danger"
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              <span className="qf-m-sheet__icon">
                <Icon name="logout" size="sm" />
              </span>
              <span>로그아웃</span>
            </button>
            <button
              type="button"
              data-testid="mobile-logout-cancel"
              className="qf-m-sheet__item"
              onClick={() => setLogoutConfirm(false)}
            >
              <span className="qf-m-sheet__icon">
                <Icon name="x" size="sm" />
              </span>
              <span>취소</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
