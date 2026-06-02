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
          // S40 fix-forward (BLOCKER a11y): Radix 1.1.15 가 Content 에 aria-modal 을
          // 출력하지 않아 AT 가 모달 경계를 인식하지 못한다. 비시각 속성이므로 모든
          // 모달에 안전하게 명시한다(focus trap 은 Radix 가 이미 처리).
          aria-modal="true"
          className={cn(
            'qf-modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            className,
          )}
        >
          <div className="qf-modal__header">
            <div>
              <RDialog.Title className="qf-modal__title">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-secondary">
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
