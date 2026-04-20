import * as RDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Radix Dialog handles focus trap + restore + escape dismiss for free.
 * We just put our design skin on it and expose a compact API.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-overlay bg-foreground/40 backdrop-blur-sm" />
        <RDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-modal w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-surface p-5 shadow-lg',
            className,
          )}
        >
          <RDialog.Title className="text-lg font-semibold text-foreground">{title}</RDialog.Title>
          {description ? (
            <RDialog.Description className="mt-1 text-sm text-text-muted">
              {description}
            </RDialog.Description>
          ) : null}
          <div className="mt-4">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
