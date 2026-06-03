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
  alertDialog = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  // S63 fix-forward (a11y HIGH-1): 되돌릴 수 없는 파괴적 확인(예: 영구 차단)은
  // role="alertdialog" 로 노출해 AT 가 즉시 주의 컨텍스트로 알리게 한다. 기본은
  // 일반 dialog(role 미지정 → Radix 기본 dialog). 비파괴 모달은 false 그대로 둔다.
  alertDialog?: boolean;
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
          // S63 fix-forward (a11y HIGH-1): 파괴적 확인은 alertdialog 역할로 노출한다.
          // alertDialog=false 면 role 을 *전혀 전달하지 않아* Radix 기본 role="dialog" 를
          // 보존한다(role={undefined} 를 명시 전달하면 Radix 기본값을 덮어써 누락된다).
          {...(alertDialog ? { role: 'alertdialog' } : {})}
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
