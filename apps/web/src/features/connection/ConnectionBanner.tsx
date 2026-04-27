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
        background: 'var(--warn-400)',
        color: 'var(--text-strong)',
        fontSize: 'var(--fs-13)',
        textAlign: 'center',
        borderBottom: '1px solid var(--warn-600)',
      }}
    >
      <span>{state.message}</span>
    </div>
  );
}
