import { useEffect, useState } from 'react';
import { computeConnectionBanner } from './computeConnectionBanner';
import type { RealtimeStatus } from '../realtime/useRealtimeConnection';

/**
 * task-040 R3: persistent live-region banner that surfaces network /
 * realtime trouble. Mounted at every Shell root (Shell, MobileShell,
 * DmShell, DiscoverShell). Uses navigator.onLine + the realtime
 * status feed; safe to unmount because it owns no socket lifecycle.
 *
 * a11y: role="status" + aria-live="polite" so screen readers announce
 * a state change without interrupting current speech.
 */
export function ConnectionBanner({
  realtimeStatus = 'idle',
  replaying = false,
}: {
  realtimeStatus?: RealtimeStatus;
  replaying?: boolean;
}): JSX.Element | null {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const state = computeConnectionBanner({ online, realtimeStatus, replaying });
  if (!state.visible) return null;

  // 072 백로그 S-H 리뷰(MEDIUM 대비): 종전 saturated 배경(warn-400/danger-400) + text-strong 은
  // 다크 테마에서 WCAG AA 미달이었다(밝은 배경에 밝은 텍스트). DS callout 패턴처럼 bg-elevated +
  // 테마-aware var(--text)(AA 보장) 로 두고, 레벨 신호는 하단 컬러 보더로 준다(색 단독 의존 회피 —
  // 텍스트로도 상태를 명시). 종단 오류(offline/failed)는 danger, 일시(disconnected/replaying)는 warn.
  const isError = state.level === 'failed' || state.level === 'offline';
  const accent = isError ? 'var(--danger-400)' : 'var(--warn-400)';

  // task-041 A-1 (review M1 follow-up): renders in normal flow as the
  // first row of a flex-column wrapper at App root (see App.tsx
  // `AppLayout`). Previously `position: fixed; z-index: 9999` overlay
  // covered the topbar — `qf-m-topbar` (z-index 2) and the desktop
  // `qf-topbar` were both shadowed when the banner fired. With the
  // wrapper at #root level enforcing flex-column, the banner now
  // pushes the rest of the layout down by its own height; overlap = 0.
  //
  // Mobile safe-area: padding-top respects env(safe-area-inset-top)
  // so on devices with a notch the warning row clears the system bar.
  return (
    <div
      data-testid="connection-banner"
      data-level={state.level}
      role="status"
      aria-live="polite"
      style={{
        flexShrink: 0,
        padding:
          'calc(var(--s-2) + env(safe-area-inset-top, 0px)) var(--s-4) var(--s-2) var(--s-4)',
        background: 'var(--bg-elevated)',
        color: 'var(--text)',
        fontSize: 'var(--fs-13)',
        textAlign: 'center',
        borderBottom: `2px solid ${accent}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--s-3)',
      }}
    >
      <span>{state.message}</span>
      {/* 072 백로그 S-H (N6-3): 종단 실패 시 새로고침 액션. 자동 복구가 없으므로 사용자가
          직접 재로드해 소켓을 새로 맺게 한다. */}
      {state.reloadable ? (
        <button
          type="button"
          data-testid="connection-banner-reload"
          onClick={() => window.location.reload()}
          className="qf-btn qf-btn--sm qf-btn--secondary"
        >
          새로고침
        </button>
      ) : null}
    </div>
  );
}
