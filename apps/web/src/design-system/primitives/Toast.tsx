import { useEffect } from 'react';
import { useNotifications, type Notification } from '../../stores/notification-store';
import { cn } from '../../lib/cn';

const variantClass: Record<Notification['variant'], string> = {
  info: '',
  success: 'qf-toast--success',
  warning: 'qf-toast--warn',
  danger: 'qf-toast--danger',
  mention: 'qf-toast--success',
};

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
      className="pointer-events-none fixed bottom-[var(--s-5)] right-[var(--s-5)] z-toast flex flex-col gap-[var(--s-3)]"
    >
      {items.map((t) => {
        const interactive = typeof t.onActivate === 'function';
        const body = (
          <>
            <div className="flex-1">
              {t.title ? <div className="qf-toast__title">{t.title}</div> : null}
              {t.body ? <div className="qf-toast__body">{t.body}</div> : null}
            </div>
          </>
        );
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
              className={cn('qf-toast pointer-events-auto text-left', variantClass[t.variant])}
            >
              {body}
            </button>
          );
        }
        return (
          <div
            key={t.id}
            data-testid={`toast-${t.variant}`}
            role={t.variant === 'danger' ? 'alert' : 'status'}
            aria-live={t.variant === 'danger' ? 'assertive' : 'polite'}
            className={cn('qf-toast pointer-events-auto', variantClass[t.variant])}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
