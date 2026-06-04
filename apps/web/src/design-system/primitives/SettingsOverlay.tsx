import * as RDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Reusable full-viewport settings popup.
 *
 * Visual shape: backdrop + card floating with fixed s-8 margin on all
 * sides (resizes with the viewport), capped at 1200px wide on very
 * large screens. Close X pinned to the top-right of the card.
 *
 * Every settings surface in the app — channel settings, workspace
 * settings, account settings — should compose inside this overlay
 * so the shell, ESC handling, focus trap, and visual chrome stay
 * consistent across them. The children slot typically holds the
 * `qf-settings` grid (nav + main), but the primitive is agnostic.
 */
export function SettingsOverlay({
  open,
  onClose,
  title,
  children,
  testId = 'settings-overlay',
}: {
  open: boolean;
  onClose: () => void;
  /** Used for the a11y title only — kept visually hidden. */
  title: string;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <RDialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="qf-settings-overlay__backdrop" />
        <RDialog.Content
          data-testid={testId}
          // S67 fix-forward (a11y M-4): Radix 1.1.x 가 Content 에 aria-modal 을 출력하지
          // 않아 AT 가 모달 경계를 인식하지 못한다. Dialog primitive 와 동일하게 명시한다
          // (focus trap 은 Radix 가 처리·primitive 는 앱코드라 DS 4파일 아님).
          aria-modal="true"
          className="qf-settings-overlay__card"
        >
          {/* Radix closes on Escape + outside click by default; both
              route through onOpenChange → onClose. */}
          <RDialog.Title className="sr-only">{title}</RDialog.Title>
          <button
            type="button"
            data-testid={`${testId}-close`}
            aria-label="설정 닫기"
            onClick={onClose}
            className="qf-settings-overlay__close"
          >
            <Icon name="x" size="md" />
          </button>
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
