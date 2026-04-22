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
        <RDialog.Content data-testid={testId} className="qf-settings-overlay__card">
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
