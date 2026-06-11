import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../features/auth/AuthProvider';
import { usePresenceStatus } from '../../features/presence/usePresenceStatus';
import { useDndSchedule } from '../../features/presence/useDndSchedule';
// 071-M3 F3: 저장함 진입(행 + IN_PROGRESS 카운트 배지).
import { useSavedCount } from '../../features/saved/useSavedMessages';
import type { PresenceStatus } from '../../features/presence/presenceStatus';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { MobileTabBar } from './MobileTabBar';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

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
  const { status, setStatus, hydrate, pending } = usePresenceStatus('online');
  const [statusSheet, setStatusSheet] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  // M2 리뷰 M-3: usePresenceStatus 는 로컬 낙관 상태뿐(GET 없음) — 서버의
  // effective preference(GET /me/dnd-schedule, 60s 폴링 공유 캐시)로 1회
  // hydrate 한다. 사용자가 이 화면에서 수동 변경한 뒤에는 덮지 않는다.
  const { data: dndData } = useDndSchedule();
  const touchedRef = useRef(false);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || touchedRef.current || !dndData) return;
    hydratedRef.current = true;
    const pref = dndData.preference;
    if (pref === 'dnd') hydrate('dnd');
    else if (pref === 'invisible') hydrate('offline');
    // 'auto' 는 online 기본값 유지. (hydrate 는 로컬 표시만 — PATCH 미발행)
  }, [dndData, hydrate]);

  const username = user?.username ?? '';
  const { data: savedCountData } = useSavedCount();
  const savedCount = savedCountData?.count ?? 0;

  const pick = (next: PresenceStatus): void => {
    touchedRef.current = true; // M-3: 수동 변경 후 hydrate 가 덮지 않게.
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
            data-testid="mobile-you-saved"
            className="qf-m-row w-full text-left"
            onClick={() => navigate('/saved')}
          >
            <Icon name="bookmark" size="sm" className="text-text-muted" />
            <span className="qf-m-row__primary flex-1">저장됨</span>
            {savedCount > 0 ? (
              <span className="qf-badge qf-badge--count" data-testid="mobile-you-saved-count">
                {savedCount > 99 ? '99+' : savedCount}
              </span>
            ) : null}
            <Icon name="chevron-right" size="sm" className="text-text-muted" />
          </button>
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

      {/* 상태 변경 바텀시트 — presence 수동 전환(온라인/DND/오프라인 표시)만.
          idle 은 자동 전용이라 선택지 제외. ★FR-P04/P17(커스텀 상태 emoji+text+
          만료 프리셋 편집)은 미구현 — fr-matrix partial, 차기 감사 오판 방지(M4). */}
      {statusSheet ? (
        <StatusSheet status={status} onPick={pick} onClose={() => setStatusSheet(false)} />
      ) : null}

      {/* 로그아웃 confirm 시트 — 파괴적 액션 우발 방지. */}
      {logoutConfirm ? (
        <LogoutConfirmSheet
          onLogout={() => {
            void logout().then(() => navigate('/login'));
          }}
          onClose={() => setLogoutConfirm(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * 071-M5 H4 (감사 A-30): 상태 변경 시트 — 종전 인라인 JSX 는 role/aria 만 있고
 * 트랩·Esc·복귀·back 마커가 전부 없었다. 트랩 훅(마운트 1회)을 쓰려면 시트가
 * 조건부 마운트 컴포넌트여야 해서 분리했다. 첫 포커스는 현재 상태 버튼
 * (aria-pressed=true) — 선택 상태를 즉시 낭독시킨다.
 */
function StatusSheet({
  status,
  onPick,
  onClose,
}: {
  status: PresenceStatus;
  onPick: (_next: PresenceStatus) => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useSheetFocusTrap(panelRef, onClose, {
    initialFocus: () =>
      panelRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? null,
  });
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);
  return (
    <div
      data-testid="mobile-status-sheet"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label="상태 변경"
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        {(['online', 'dnd', 'offline'] as PresenceStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`mobile-status-${s}`}
            className="qf-m-sheet__item"
            aria-pressed={status === s}
            onClick={() => onPick(s)}
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
  );
}

/**
 * 071-M5 H4 (감사 A-30 alertdialog 요건): 로그아웃 confirm — 취소가 첫 포커스다.
 * DOM 은 파괴 액션(로그아웃)이 먼저인 시각 레이아웃을 유지하고 initialFocus 로만
 * 취소를 지정한다(DOM 재배치 없이 우발 확정 방지).
 */
function LogoutConfirmSheet({
  onLogout,
  onClose,
}: {
  onLogout: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useSheetFocusTrap(panelRef, onClose, { initialFocus: () => cancelRef.current });
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);
  return (
    <div
      data-testid="mobile-logout-confirm"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="alertdialog"
      aria-modal="true"
      aria-label="로그아웃 확인"
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        <button
          type="button"
          data-testid="mobile-logout-submit"
          className="qf-m-sheet__item qf-m-sheet__item--danger"
          onClick={onLogout}
        >
          <span className="qf-m-sheet__icon">
            <Icon name="logout" size="sm" />
          </span>
          <span>로그아웃</span>
        </button>
        <button
          type="button"
          ref={cancelRef}
          data-testid="mobile-logout-cancel"
          className="qf-m-sheet__item"
          onClick={onClose}
        >
          <span className="qf-m-sheet__icon">
            <Icon name="x" size="sm" />
          </span>
          <span>취소</span>
        </button>
      </div>
    </div>
  );
}
