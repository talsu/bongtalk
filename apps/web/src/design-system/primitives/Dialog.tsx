import * as RDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

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
        <RDialog.Overlay className="qf-modal-backdrop !fixed !inset-0" />
        <RDialog.Content
          className={cn(
            'qf-modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            className,
          )}
        >
          <div className="qf-modal__header">
            <div>
              <RDialog.Title className="qf-modal__title">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-[var(--s-2)] text-[13px] text-text-secondary">
                  {description}
                </RDialog.Description>
              ) : null}
            </div>
          </div>
          <div className="qf-modal__body pb-[var(--s-6)]">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
