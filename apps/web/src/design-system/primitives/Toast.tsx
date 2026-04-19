import { useEffect } from 'react';
import { useNotifications, type Notification } from '../../stores/notification-store';
import { cn } from '../../lib/cn';

const variantStyles: Record<Notification['variant'], string> = {
  info: 'bg-bg-surface border-border-subtle',
  success: 'bg-success text-fg-primary border-success',
  warning: 'bg-warning text-foreground border-warning',
  danger: 'bg-danger text-fg-primary border-danger',
  mention: 'bg-bg-accent text-foreground border-bg-primary',
};

/**
 * Lightweight toast stack. A global aria-live region ensures screen readers
 * announce new toasts without the user having to focus them.
 */
export function ToastViewport(): JSX.Element {
  const { items, dismiss } = useNotifications();
  useEffect(() => {
    const timers = items.map((t) => {
      const ttl = t.ttlMs ?? 4000;
      return setTimeout(() => dismiss(t.id), ttl);
    });
    return () => timers.forEach(clearTimeout);
  }, [items, dismiss]);

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-toast flex flex-col gap-2"
    >
      {items.map((t) => {
        const interactive = typeof t.onActivate === 'function';
        // Mention toasts click-to-jump; render as <button> for keyboard
        // access. Non-interactive variants keep the plain <div> so
        // screen-readers don't get spurious "button" announcements.
        if (interactive) {
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`toast-${t.variant}`}
              role={t.variant === 'danger' ? 'alert' : 'status'}
              aria-live={t.variant === 'danger' ? 'assertive' : 'polite'}
              onClick={() => {
                t.onActivate?.();
                dismiss(t.id);
              }}
              className={cn(
                'pointer-events-auto block min-w-[240px] max-w-sm rounded-md border px-3 py-2 text-left text-sm shadow-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-95',
                variantStyles[t.variant],
              )}
            >
              {t.title ? <div className="font-medium">{t.title}</div> : null}
              {t.body ? <div className="text-xs opacity-90">{t.body}</div> : null}
            </button>
          );
        }
        return (
          <div
            key={t.id}
            data-testid={`toast-${t.variant}`}
            role={t.variant === 'danger' ? 'alert' : 'status'}
            aria-live={t.variant === 'danger' ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto min-w-[240px] max-w-sm rounded-md border px-3 py-2 text-sm shadow-md',
              variantStyles[t.variant],
            )}
          >
            {t.title ? <div className="font-medium">{t.title}</div> : null}
            {t.body ? <div className="text-xs opacity-90">{t.body}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
