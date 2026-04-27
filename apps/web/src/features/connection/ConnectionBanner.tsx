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

  // Inline styles use existing DS tokens (var(--warn-*) / var(--bg-*))
  // — DS 4 source files stay byte-identical; no new qf-* class added.
  return (
    <div
      data-testid="connection-banner"
      data-level={state.level}
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        padding: 'var(--s-2) var(--s-4)',
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
