import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Edge-anchored overlay drawer — DS mobile pattern for sidebar
 * (workspaces/channels) and member list. Uses body-portal-style
 * overlay + sliding panel. Close on backdrop click, ESC, or the
 * drawer's own onClose (e.g. after a row pick in the children).
 */
export function MobileDrawer({
  side,
  open,
  onClose,
  testId,
  children,
}: {
  side: 'left' | 'right';
  open: boolean;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid={`${testId}-root`}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      aria-modal="true"
      role="dialog"
    >
      <div
        data-testid={`${testId}-backdrop`}
        className="qf-m-sheet-backdrop absolute inset-0"
        onClick={onClose}
      />
      <aside
        data-testid={testId}
        style={{ width: '86%', maxWidth: '360px', boxShadow: 'var(--elev-3)' }}
        className={cn(
          'absolute top-0 bottom-0 bg-bg-panel overflow-y-auto',
          side === 'left' ? 'left-0' : 'right-0',
        )}
      >
        {children}
      </aside>
    </div>
  );
}
