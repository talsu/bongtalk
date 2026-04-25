import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { Icon } from '../../design-system/primitives';
import { MobileMessages } from './MobileMessages';

/**
 * task-035-F: chat overlay that slides in over MobileHome. Pure CSS
 * transform so the Home tree stays mounted (no unmount flicker), just
 * obscured by z-index. Close paths:
 *   - qf-m-topbar__back chevron
 *   - browser back (popstate) — we push a marker state on open
 *   - swipe-right from the left edge (<20px) past 40px + momentum
 */
export function MobileOverlay({
  title,
  onClose,
  workspaceId,
  workspaceSlug,
  channelId,
  channelName,
  extraNames,
  ...rest
}: {
  title: string;
  onClose: () => void;
  /** null for Global DM channels (no host workspace). */
  workspaceId: string | null;
  workspaceSlug: string | null;
  channelId: string;
  channelName: string;
  extraNames?: Map<string, string>;
  'data-testid'?: string;
}): JSX.Element {
  const [mounted, setMounted] = useState(false);
  const [dragX, setDragX] = useState(0);
  const edgeStart = useRef<number | null>(null);

  // Slide in on mount; push a history entry so the hardware back button
  // closes us without navigating the whole shell.
  useEffect(() => {
    // Defer one frame so the initial translateX(100%) paints before
    // the transition target.
    const id = requestAnimationFrame(() => setMounted(true));
    window.history.pushState({ overlay: 'chat', channelId }, '');
    const onPop = (): void => {
      onClose();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('popstate', onPop);
    };
  }, [channelId, onClose]);

  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (t.clientX < 20) {
      edgeStart.current = t.clientX;
    }
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (edgeStart.current === null) return;
    const t = e.touches[0];
    const dx = t.clientX - edgeStart.current;
    if (dx > 0) setDragX(Math.min(dx, 400));
  };
  const onTouchEnd = (): void => {
    if (edgeStart.current === null) return;
    if (dragX > 40) {
      // Snap away — history.back drives popstate → onClose.
      window.history.back();
    } else {
      setDragX(0);
    }
    edgeStart.current = null;
  };

  const baseTranslate = mounted ? 0 : 100;
  const translatePx = dragX;

  return (
    <div
      {...rest}
      data-testid={rest['data-testid'] ?? 'mobile-overlay'}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      style={{
        background: 'var(--bg-chat)',
        transform:
          translatePx > 0 ? `translateX(${translatePx}px)` : `translateX(${baseTranslate}%)`,
        transition:
          translatePx > 0
            ? 'none'
            : 'transform var(--dur-fast, 150ms) var(--ease-standard, ease-out)',
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="qf-m-screen h-full">
        <header className="qf-m-topbar qf-m-safe-top">
          <button
            type="button"
            data-testid="mobile-overlay-back"
            aria-label="뒤로"
            className="qf-m-topbar__back"
            onClick={() => window.history.back()}
          >
            <Icon name="chevron-left" size="md" />
          </button>
          <div className="qf-m-topbar__titleBlock">
            <div className="qf-m-topbar__title">{title}</div>
          </div>
          <div />
        </header>
        <MobileMessages
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          channelId={channelId}
          channelName={channelName}
          extraNames={extraNames}
        />
      </div>
    </div>
  );
}
